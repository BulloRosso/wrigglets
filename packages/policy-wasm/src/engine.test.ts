import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_ENTRY, OBJECT_ENTRY, PolicyEngine, packageRevision } from './index.js';

/* The real policies/liquid compiled with the pinned OPA image (Docker), evaluated in-process. Skipped without Docker. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OPA = 'openpolicyagent/opa:1.22.0-static@sha256:906bfc9904b2693733e7959d71773dd073e6c135cf06f26d955abe94603e82b3';
const docker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
let wasm = '';
let data: Record<string, unknown>;

beforeAll(() => {
  if (!docker) return;
  const out = mkdtempSync(path.join(os.tmpdir(), 'cw-wasm-'));
  execFileSync('docker', ['run', '--rm', '-v', `${path.join(root, 'policies').split(path.sep).join('/')}:/p:ro`, '-v', `${out.split(path.sep).join('/')}:/out`, OPA, 'build', '-t', 'wasm', '-e', 'liquid/gateway/decision', '-e', 'liquid/object/decision', '--ignore', '*_test.rego', '-o', '/out/b.tar.gz', '/p/liquid'], { stdio: 'pipe' });
  execFileSync('tar', ['xzf', 'b.tar.gz'], { cwd: out });
  const file = execFileSync('tar', ['tzf', 'b.tar.gz'], { cwd: out, encoding: 'utf8' }).split('\n').find((x) => x.endsWith('policy.wasm'))!;
  wasm = readFileSync(path.join(out, file.replace(/^\//, ''))).toString('base64');
  const roles = JSON.parse(readFileSync(path.join(root, 'policies/liquid/roles/data.json'), 'utf8'));
  const ontology = JSON.parse(execFileSync(process.execPath, ['-e', `import('${pathToFileURL(path.join(root, 'packages/ontology-codegen/dist/index.js')).href}').then((m) => process.stdout.write(JSON.stringify(m.opaData(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))))))`, path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json')], { encoding: 'utf8' })).liquid.ontology;
  data = { liquid: { ontology, roles: { roles: roles.roles, agents: roles.agents }, overlays: [] } };
}, 180_000);

const caller = (agent: string | null, extra: Record<string, unknown> = {}) => ({ agent, user: null, approved_by: null, workflow: null, task: { id: null, step: null }, ...extra });
const po = { class: 'PurchaseOrder', id: 'PO-1', criticality: 'payment_critical', data_class: 'confidential', owner: 'x', status: 'open' };

describe.skipIf(!docker)('embedded policy engine', () => {
  it('fails closed before a package is loaded', () => {
    expect(new PolicyEngine().decide(GATEWAY_ENTRY, {})).toMatchObject({ allow: false, reason: expect.stringMatching(/fail closed/) });
  });

  it('gateway: role, plan step and kill switch decisions as with the OPA service', async () => {
    const e = new PolicyEngine();
    await e.load({ revision: packageRevision(wasm, data), wasm, data });
    const g = (agent: string, action: string, step = 'run', killSwitch = 'normal') => e.decide(GATEWAY_ENTRY, { agent: { id: agent }, tool: `erp__${action}`, upstream: 'erp', action, task: { step }, killSwitch });
    expect(g('sofa-max', 'request_overtime')).toMatchObject({ allow: true });
    expect(g('sofa-horst', 'create_purchase_order')).toMatchObject({ allow: false, reason: expect.stringMatching(/no role/) });
    expect(g('sofa-max', 'request_overtime', 'plan')).toMatchObject({ allow: false });
    expect(g('sofa-max', 'request_overtime', 'run', 'tools_off')).toMatchObject({ allow: false });
  });

  it('object: four eyes, approval by another person, overlays with expiry (host time builtins)', async () => {
    const e = new PolicyEngine();
    const overlays = [
      { id: 'ov-1', effect: 'deny', reason: 'old', match: { actions: ['request_overtime'] }, expires_at: '2020-01-01T00:00:00Z' },
      { id: 'ov-2', effect: 'deny', reason: 'supplier frozen', match: { classes: ['Supplier'] }, expires_at: '2099-01-01T00:00:00Z' },
    ];
    const d2 = { liquid: { ...(data.liquid as object), overlays } };
    await e.load({ revision: packageRevision(wasm, d2), wasm, data: d2 });
    expect(e.decide(OBJECT_ENTRY, { action: 'cancel_purchase_order', caller: caller('sofa-lara'), objects: [po] }).obligations).toEqual(['require_four_eyes']);
    expect(e.decide(OBJECT_ENTRY, { action: 'cancel_purchase_order', caller: caller('sofa-lara', { user: 'stefan@x', approved_by: 'ben@x' }), objects: [po] }).obligations).toEqual([]);
    expect(e.decide(OBJECT_ENTRY, { action: 'request_overtime', caller: caller('sofa-max'), objects: [] })).toMatchObject({ allow: true });
    expect(e.decide(OBJECT_ENTRY, { action: 'list_suppliers', caller: caller('sofa-lara'), objects: [{ ...po, class: 'Supplier' }] })).toMatchObject({ allow: false, reason: expect.stringMatching(/supplier frozen/) });
    expect(e.decide(OBJECT_ENTRY, { action: 'nope_action', caller: caller('x'), objects: [] })).toMatchObject({ allow: false, reason: expect.stringMatching(/unknown action/) });
  });

  it('a data update does not re-instantiate the module; the revision follows the content', async () => {
    const e = new PolicyEngine();
    await e.load({ revision: 'a', wasm, data });
    const before = (e as unknown as { policy: unknown }).policy;
    await e.load({ revision: 'b', wasm, data: { liquid: { ...(data.liquid as object), overlays: [] } } });
    expect((e as unknown as { policy: unknown }).policy).toBe(before);
    expect(packageRevision(wasm, data)).not.toBe(packageRevision(wasm, { x: 1 }));
  });
});
