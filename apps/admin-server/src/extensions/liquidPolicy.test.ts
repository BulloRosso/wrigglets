import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiquidPolicyService, tarGz, untarGz } from './liquidPolicy.js';

const policyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../policies/liquid');
const ontologyData = { liquid: { ontology: { name: 'sofa', version: '0.1.0', classes: { Supplier: { criticality: 'business_critical' } }, actions: { get_kpi: { read_only: true } } } } };

let dir: string;
let svc: LiquidPolicyService;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pol-'));
  svc = new LiquidPolicyService(dir, policyDir, async () => ontologyData, () => 'query-token-123');
  await svc.load();
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('tar.gz', () => {
  it('round-trips files and is deterministic', () => {
    const files = { 'b/x.rego': 'package x', 'a.json': '{"k":1}', ['long/'.repeat(10) + 'f.txt']: 'ä'.repeat(1000) };
    expect(untarGz(tarGz(files))).toEqual(files);
    expect(tarGz(files).equals(tarGz({ ...files }))).toBe(true);
  });
});

describe('bundle', () => {
  it('contains the policies (not the tests), one data.json and a manifest with roots', async () => {
    const { revision, body } = await svc.bundle();
    const files = untarGz(body);
    expect(Object.keys(files).sort()).toEqual(['.manifest', 'data.json', 'liquid/common.rego', 'liquid/gateway.rego', 'liquid/object.rego', 'system/authz.rego']);
    expect(JSON.parse(files['.manifest']!)).toEqual({ revision, roots: ['liquid', 'system'] });
    const data = JSON.parse(files['data.json']!);
    expect(data.liquid.ontology.name).toBe('sofa');
    expect(data.liquid.roles.agents['sofa-lara']).toBe('procurement');
    expect(data.liquid.roles._doc).toBeUndefined();
    expect(data.liquid.overlays).toEqual([]);
    expect(data.system.authz.query_token).toBe('query-token-123');
  });

  it('the revision is stable and changes with an overlay', async () => {
    const a = await svc.bundle();
    expect((await svc.bundle()).revision).toBe(a.revision);
    const o = await svc.addOverlay({ effect: 'deny', reason: 'upstream under review', match: { upstreams: ['erp'] } }, 'admin@x');
    const b = await svc.bundle();
    expect(b.revision).not.toBe(a.revision);
    expect(JSON.parse(untarGz(b.body)['data.json']!).liquid.overlays).toEqual([{ id: o.id, effect: 'deny', reason: 'upstream under review', match: { upstreams: ['erp'] }, source: 'admin' }]);
    await svc.removeOverlay(o.id);
    expect((await svc.bundle()).revision).toBe(a.revision);
  });

  it('keeps the last known ontology data when the ontology server is down', async () => {
    await svc.bundle();
    const down = new LiquidPolicyService(dir, policyDir, async () => Promise.reject(new Error('down')), () => 't');
    const files = untarGz((await down.bundle()).body);
    expect(JSON.parse(files['data.json']!).liquid.ontology).toEqual({});
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

describe('decision logs', () => {
  it('keeps decisions without full inputs', () => {
    const batch = [{ timestamp: '2026-11-16T10:00:00Z', path: 'liquid/gateway/decision', result: { allow: false, reason: 'agent sofa-horst has no role', obligations: [] }, input: { agent: { id: 'sofa-horst' }, action: 'create_purchase_order', tool: 'erp__create_purchase_order' } }];
    svc.recordDecisions(gzipSync(Buffer.from(JSON.stringify(batch))), true);
    svc.recordDecisions(Buffer.from(JSON.stringify(batch)), false); // already inflated by the body parser
    expect(svc.status().decisions).toHaveLength(2);
    expect(svc.status().decisions.slice(0, 1)).toEqual([{ at: '2026-11-16T10:00:00Z', path: 'liquid/gateway/decision', allow: false, reason: 'agent sofa-horst has no role', obligations: [], input: { agent: 'sofa-horst', action: 'create_purchase_order', tool: 'erp__create_purchase_order', caller: undefined } }]);
  });
});
