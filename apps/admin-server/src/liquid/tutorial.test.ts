import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { compileOntology } from './compiler.js';
import { DD_RULE, buildDueDiligenceChange, bumpMinor } from './tutorialChanges.js';
import { TUTORIAL_ACTIONS, isLocalUrl, tutorialRouter, type TutorialDeps } from './tutorialApi.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('tutorial: the prepared due-diligence change (ADR-0054)', () => {
  const files = { schema: read('ontology/sofa/schema.yaml'), actions: read('ontology/sofa/actions.yaml'), roles: read('policies/liquid/roles/data.json') };
  const version = /^version: (.*)$/m.exec(files.schema)![1]!.trim();

  it('compiles, raises the minor version and puts the rule on the release', () => {
    const changes = buildDueDiligenceChange({ ...files, version });
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.content]));
    const out = compileOntology({ 'schema.yaml': byPath['ontology/sofa/schema.yaml']!, 'actions.yaml': byPath['ontology/sofa/actions.yaml']!, 'bindings.yaml': read('ontology/sofa/bindings.yaml') });
    expect(out.errors ?? []).toEqual([]);
    expect(out.ir!.version).toBe(bumpMinor(version));
    expect(out.ir!.actions.find((a) => a.name === 'release_purchase_order')?.preconditions).toContain(DD_RULE);
    expect(out.ir!.actions.map((a) => a.name)).toEqual(expect.arrayContaining(['set_commodity_risk', 'submit_due_diligence_statement']));
    expect(out.ir!.classes.find((c) => c.name === 'Material')?.attributes.some((a) => a.name === 'commodity_risk')).toBe(true);
    expect((JSON.parse(byPath['policies/liquid/roles/data.json']!) as { roles: { procurement: { writes: string[] } } }).roles.procurement.writes).toContain('set_commodity_risk');
  });

  it('applied twice adds nothing twice (a repository where an earlier run left parts of it)', () => {
    const once = Object.fromEntries(buildDueDiligenceChange({ ...files, version }).map((c) => [c.path, c.content]));
    const twice = Object.fromEntries(buildDueDiligenceChange({ schema: once['ontology/sofa/schema.yaml']!, actions: once['ontology/sofa/actions.yaml']!, roles: once['policies/liquid/roles/data.json']!, version: bumpMinor(version) }).map((c) => [c.path, c.content]));
    const count = (s: string, x: string) => s.split(x).length - 1;
    expect(count(twice['ontology/sofa/actions.yaml']!, '- name: set_commodity_risk')).toBe(1);
    expect(count(twice['ontology/sofa/actions.yaml']!, `  ${DD_RULE}:`)).toBe(1);
    expect(count(twice['ontology/sofa/schema.yaml']!, 'commodity_risk:')).toBe(1);
  });
});

describe('tutorial API guards', () => {
  it('shows the Git host login only for a host on this machine', () => {
    expect(isLocalUrl('http://localhost:3300')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:3300')).toBe(true);
    expect(isLocalUrl('https://git.example.com')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });

  it('runs only the whitelisted actions; an agent call carries no person', async () => {
    expect(Object.keys(TUTORIAL_ACTIONS).sort()).toEqual(['cancel_purchase_order', 'create_purchase_order', 'set_commodity_risk']);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, result: 'done', seq: 7 }), { status: 200 });
    }) as typeof fetch;
    try {
      const ext = { isAvailable: async () => true, isInstalled: () => true, get: () => ({ id: 'liquid', available: true }), status: () => ({ available: true }), secret: () => 'tok', url: () => 'http://core', publicUrl: () => 'http://localhost:3300' };
      const app = express();
      app.use(express.json());
      app.use('/api', tutorialRouter({ ext, gateway: { upstreams: [] }, killSwitch: { get: () => ({}) } } as unknown as TutorialDeps, () => 'anna@example.com'));
      app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }));
      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;
      const post = (body: unknown) => orig(`http://127.0.0.1:${port}/api/liquid/tutorial/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      try {
        expect((await post({ action: 'release_purchase_order', args: { poId: 'PO-1' } })).status).toBe(400);
        const ok = await post({ action: 'cancel_purchase_order', args: { poId: 'PO-1', reason: 'x', _approvedBy: 'me' } });
        expect(await ok.json()).toMatchObject({ ok: true, as: 'sofa-lara' });
        expect(calls.at(-1)).toEqual({ url: 'http://core/actions/cancel_purchase_order', body: { poId: 'PO-1', reason: 'x', _agent: 'sofa-lara' } });
        await post({ action: 'create_purchase_order', args: { supplierId: 'S-1', sku: 'X', quantity: 5 } });
        expect(calls.at(-1)!.body).toEqual({ supplierId: 'S-1', sku: 'X', quantity: 5, _requestedBy: 'anna@example.com' });
      } finally {
        server.close();
      }
    } finally {
      globalThis.fetch = orig;
    }
  });
});
