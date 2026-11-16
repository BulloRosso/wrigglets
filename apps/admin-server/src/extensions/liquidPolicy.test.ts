import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiquidPolicyService } from './liquidPolicy.js';

const policyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../policies/liquid');
const ontologyData = { liquid: { ontology: { name: 'sofa', version: '0.1.0', classes: { Supplier: { criticality: 'business_critical' } }, actions: { get_kpi: { read_only: true } } } } };

let dir: string;
let svc: LiquidPolicyService;
let compiled: string[][] = [];
const compile = async (files: Record<string, string>) => {
  compiled.push(Object.keys(files));
  return { ok: true, wasm: 'd2FzbQ==' };
};
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pol-'));
  compiled = [];
  svc = new LiquidPolicyService(dir, policyDir, async () => ontologyData, compile);
  await svc.load();
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('policy package (WASM + data)', () => {
  it('compiles the policies without tests and system/, bundles roles, ontology and overlays', async () => {
    const pkg = await svc.package();
    expect(compiled[0]!.sort()).toEqual(['liquid/common.rego', 'liquid/gateway.rego', 'liquid/object.rego']);
    expect(pkg.wasm).toBe('d2FzbQ==');
    expect((pkg.data as { liquid: { ontology: { name: string } } }).liquid.ontology.name).toBe('sofa');
    const liquid = (pkg.data as { liquid: { roles: { agents: Record<string, string>; _doc?: string }; overlays: unknown[] } }).liquid;
    expect(liquid.roles.agents['sofa-lara']).toBe('procurement');
    expect(liquid.roles._doc).toBeUndefined();
    expect(liquid.overlays).toEqual([]);
  });

  it('the revision is stable, changes with an overlay; the WASM is compiled only when the Rego changes', async () => {
    const a = await svc.package();
    expect((await svc.package()).revision).toBe(a.revision);
    const o = await svc.addOverlay({ effect: 'deny', reason: 'upstream under review', match: { upstreams: ['erp'] } }, 'admin@x');
    const b = await svc.package();
    expect(b.revision).not.toBe(a.revision);
    expect((b.data as { liquid: { overlays: unknown[] } }).liquid.overlays).toEqual([{ id: o.id, effect: 'deny', reason: 'upstream under review', match: { upstreams: ['erp'] }, source: 'admin' }]);
    await svc.removeOverlay(o.id);
    expect((await svc.package()).revision).toBe(a.revision);
    expect(compiled).toHaveLength(1);
  });

  it('a compile error keeps the last good WASM; without one it fails', async () => {
    await svc.package();
    const broken = new LiquidPolicyService(dir, policyDir, async () => ontologyData, async () => ({ ok: false, errors: [{ path: 'opa build', message: 'rego_parse_error' }] }));
    await expect(broken.package()).rejects.toThrow(/rego_parse_error/);
    const status = await svc.status();
    expect(status.bundle?.engine).toBe('wasm');
  });

  it('keeps the last known ontology data when the enterprise core is down', async () => {
    const down = new LiquidPolicyService(dir, policyDir, async () => Promise.reject(new Error('down')), compile);
    expect((((await down.package()).data as { liquid: { ontology: unknown } }).liquid.ontology)).toEqual({});
  });
});

describe('overlays', () => {
  it('must match something and use a known effect', async () => {
    await expect(svc.addOverlay({ effect: 'deny', reason: 'too broad', match: {} } as never, 'a')).rejects.toThrow(/must match something/);
    await expect(svc.addOverlay({ effect: 'allow', reason: 'loosening', match: { actions: ['x_y'] } } as never, 'a')).rejects.toThrow();
  });
  it('are persisted with id, author and time', async () => {
    const o = await svc.addOverlay({ effect: 'require_four_eyes', reason: 'vulnerability', match: { classes: ['Supplier'] }, source: 'playbook:x/run-1' }, 'playbook');
    const again = new LiquidPolicyService(dir, policyDir, async () => ontologyData, () => 't');
    await again.load();
    expect(again.listOverlays()).toEqual([o]);
    expect(o).toMatchObject({ id: 'ov-1', createdBy: 'playbook', source: 'playbook:x/run-1' });
  });
});
