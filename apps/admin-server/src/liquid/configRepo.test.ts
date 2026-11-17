import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OntologyIr } from '@cw/ontology-ir';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GATEWAY_LIMITS, DEFAULT_SAFETY_RULES } from '@cw/shared';
import { ConfigRepoService, type ConfigTargets } from './configRepo.js';
import { exportState, parseState, requiredOwners, satisfies, type DesiredState } from './layout.js';

const PLAYBOOK = ['id: notify-on-alert', 'version: 1', 'trigger: { kind: alert, match: { source: test } }', 'steps:', '  - { id: tell, type: notify, autonomy: auto, with: { subject: hello } }', ''].join(String.fromCharCode(10));
const SECRET = 'very-secret-internal-token-1234567890';
const ADMIN = { email: 'ada@example.local', roles: ['Platform.Admin'] };

function state(): DesiredState {
  return {
    upstreams: [
      { name: 'erp', description: 'ERP', url: 'http://mcp-sofa:7660/erp/mcp', headers: { Authorization: { secretRef: 'erp-token' }, 'X-Literal-Token': SECRET, 'X-Tenant': 'sofa' }, enabled: true, auth: 'static', oboFallback: 'deny', policy: 'none' },
    ],
    allowedTools: { 'sofa-lara': ['erp__*'], 'sofa-max': ['erp__get_kpi'] },
    limits: { ...DEFAULT_GATEWAY_LIMITS },
    safetyRules: structuredClone(DEFAULT_SAFETY_RULES),
    agents: [{ agentId: 'sofa-lara', displayName: 'Lara', gitEmail: 'lara@agents.local', image: 'coworking/agent:local', model: 'gpt-5.4-mini', resources: { cpus: 1, memoryMb: 2048 } }],
    overlays: [],
  };
}

class FakeTargets implements ConfigTargets {
  s = state();
  applied: string[][] = [];
  current() {
    return structuredClone(this.s);
  }
  async apply(d: DesiredState) {
    const changes: string[] = [];
    if (JSON.stringify(d.allowedTools) !== JSON.stringify(this.s.allowedTools)) changes.push('allow-lists');
    if (JSON.stringify(d.safetyRules) !== JSON.stringify(this.s.safetyRules)) changes.push('safety');
    // literal credential headers are not in the repository: keep them (they live in /data)
    const keep = this.s.upstreams;
    this.s = { ...structuredClone(d), upstreams: d.upstreams.map((u) => ({ ...u, headers: { ...Object.fromEntries(Object.entries(keep.find((k) => k.name === u.name)?.headers ?? {}).filter(([h, v]) => typeof v === 'string' && /token/i.test(h))), ...u.headers } })) };
    this.applied.push(changes);
    return changes;
  }
  secrets() {
    return [SECRET];
  }
}

let dir: string;
let t: FakeTargets;
let svc: ConfigRepoService;
const seed = { 'ontology/sofa/README.md': 'x' };

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cw-config-'));
  t = new FakeTargets();
  svc = new ConfigRepoService(dir, t);
  await svc.load();
});
afterEach(async () => {
  svc.stop();
  await rm(dir, { recursive: true, force: true });
});

const allowList = async (rev = 'main') => YAML.parse(((await svc.read('gateway/allow-lists.yaml', rev)) as { content: string }).content).allowedTools as Record<string, string[]>;

describe('layout', () => {
  it('export → parse round trip; literal credentials never reach the files', () => {
    const files = exportState(state());
    const { state: back, errors } = parseState(files);
    expect(errors).toEqual([]);
    expect(back!.allowedTools).toEqual(state().allowedTools);
    expect(back!.upstreams[0]!.headers).toEqual({ Authorization: { secretRef: 'erp-token' }, 'X-Tenant': 'sofa' });
    expect(Object.values(files).join('\n')).not.toContain(SECRET);
  });
  it('order and duplicates in hand-written files do not count as a difference', () => {
    const files = exportState(state());
    files['gateway/allow-lists.yaml'] = 'allowedTools:\n  sofa-max: [erp__get_kpi]\n  sofa-lara: ["erp__*", "erp__*"]\n';
    expect(parseState(files).state!.allowedTools).toEqual(parseState(exportState(state())).state!.allowedTools);
  });
  it('reports every schema error with its file', () => {
    const files = exportState(state());
    files['gateway/allow-lists.yaml'] = 'allowedTools:\n  sofa-lara: ["erp__*", "BAD TOOL"]\n';
    files['agents/sofa-lara.yaml'] = 'agentId: sofa-lara\ndisplayName: Lara\n';
    files['secrets.txt'] = 'x';
    const paths = parseState(files).errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['gateway/allow-lists.yaml', 'agents/sofa-lara.yaml', 'secrets.txt']));
  });
  it('a literal credential header in a file is rejected', () => {
    const files = exportState(state());
    files['gateway/upstreams.yaml'] = files['gateway/upstreams.yaml']!.replace('X-Tenant: sofa', 'X-Api-Key: abc');
    expect(parseState(files).errors[0]!.message).toMatch(/Key Vault reference/);
  });
  it('owners: last matching rule wins, class owners resolve through teams', () => {
    const owners = { teams: { 'head-of-logistics': ['bea@x'] }, rules: [{ path: '**', owners: ['role:Platform.Admin'] }, { path: 'gateway/**', owners: ['ops@x'] }] };
    expect(requiredOwners(owners, ['gateway/allow-lists.yaml'])).toEqual([{ for: 'gateway/allow-lists.yaml', owners: ['ops@x'] }]);
    const sets = requiredOwners(owners, ['ontology/sofa/schema.yaml'], ['head-of-logistics', 'unknown-team']);
    expect(sets.map((s) => s.owners)).toEqual([['role:Platform.Admin'], ['bea@x']]);
    expect(satisfies({ email: 'BEA@x', roles: [] }, ['bea@x'])).toBe(true);
    expect(satisfies(ADMIN, ['ops@x'])).toBe(false);
  });
});

describe('config repository', () => {
  it('bootstraps once from the running state, without secrets', async () => {
    const r = await svc.init(seed, 'ada@example.local');
    expect(r.created).toBe(true);
    expect((await svc.init(seed, 'ada@example.local')).created).toBe(false);
    const st = await svc.status();
    expect(st.files).toEqual(expect.arrayContaining(['OWNERS.yaml', 'README.md', 'agents/sofa-lara.yaml', 'gateway/allow-lists.yaml', 'safety/rules.yaml', 'ontology/sofa/README.md']));
    expect(st.inSync).toBe(true);
    const all = await svc.git.files('main');
    expect(Object.values(all).join('\n')).not.toContain(SECRET);
    expect(st.log[0]!.body).toMatch(/Requested-By: ada@example.local/);
  });

  it('console edits become commits with the admin as author; no change → no commit', async () => {
    await svc.init(seed, 'ada@example.local');
    t.s.allowedTools['sofa-max'] = ['erp__get_kpi', 'erp__list_suppliers'];
    const c = await svc.capture('ben@example.local', 'PUT /api/agents/sofa-max/tools');
    expect(c).toBeTruthy();
    expect((await allowList())['sofa-max']).toEqual(['erp__get_kpi', 'erp__list_suppliers']);
    const [last] = (await svc.status()).log;
    expect(last).toMatchObject({ email: 'ben@example.local', subject: 'console: PUT /api/agents/sofa-max/tools' });
    expect(await svc.capture('ben@example.local', 'again')).toBeNull();
    expect((await svc.status()).inSync).toBe(true);
  });

  it('reconcile is idempotent and restores the stores from the repository (empty /data/admin)', async () => {
    await svc.init(seed, 'ada@example.local');
    expect(await svc.reconcile()).toMatchObject({ ok: true, unchanged: true });
    // stores lost their state (fresh /data/admin with defaults)
    t.s.allowedTools = {};
    t.s.safetyRules = [];
    const r = await svc.reconcile(); // no force: the drift alone triggers the apply
    expect(r).toMatchObject({ ok: true });
    expect(t.s.allowedTools).toEqual(state().allowedTools);
    expect(t.s.safetyRules).toEqual([...state().safetyRules].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await svc.drift()).toEqual([]);
    expect(await svc.reconcile()).toMatchObject({ unchanged: true });
  });

  it('pending pull requests are settled from the Git host when a webhook was lost or the host was recreated', async () => {
    await svc.init(seed, 'ada@example.local');
    const host = new Map<number, { state: 'open' | 'closed'; merged: boolean; ref: string } | 'gone'>();
    let next = 0;
    let down = false;
    svc.forge = {
      push: async () => true,
      fetch: async () => null,
      openPr: async (o: { branch: string }) => {
        next++;
        host.set(next, { state: 'open', merged: false, ref: o.branch });
        return { number: next, state: 'open', merged: false, html_url: '', head: { ref: o.branch, sha: '' }, title: '' };
      },
      status: async () => undefined,
      prUrl: (n: number) => `http://host/pulls/${n}`,
      pr: async (n: number) => {
        if (down) throw Object.assign(new Error('fetch failed'), { status: 0 });
        const h = host.get(n);
        if (!h || h === 'gone') throw Object.assign(new Error('not found'), { status: 404 });
        return { number: n, state: h.state, merged: h.merged, merged_by: h.merged ? { login: 'reviewer' } : null, html_url: '', head: { ref: h.ref, sha: '' }, title: '' };
      },
    } as unknown as Forge;
    const allow = exportState(t.current())['gateway/allow-lists.yaml']!;
    const mk = (t: string) => svc.propose({ title: `proposal ${t}`, reason: 'lost webhook test', changes: [{ path: 'gateway/allow-lists.yaml', content: allow.replace('- erp__*', `- erp__${t}`) }], author: { kind: 'agent', id: 'sofa-max' } });
    const [closed, gone, reused, open] = [await mk('a'), await mk('b'), await mk('c'), await mk('d')];
    host.set(closed.pr!.number, { state: 'closed', merged: false, ref: closed.branch });
    host.set(gone.pr!.number, 'gone');
    host.set(reused.pr!.number, { state: 'open', merged: false, ref: 'proposal/someone-else' });
    down = true;
    await svc.reconcile();
    expect((await svc.get(closed.id)).status).toBe('pending'); // host unreachable: nothing settled
    down = false;
    await svc.reconcile();
    const st = async (id: string) => (await svc.get(id)).status;
    expect([await st(closed.id), await st(gone.id), await st(reused.id), await st(open.id)]).toEqual(['rejected', 'rejected', 'rejected', 'pending']);
    expect((await svc.get(gone.id)).comment).toMatch(/no longer exists/);
  });

  it('while the gate is closed (uninstall running) no reconcile writes the stores, whoever triggers it', async () => {
    await svc.init(seed, 'ada@example.local');
    t.s.allowedTools['sofa-max'] = ['erp__get_kpi', 'crm__list_customers']; // e.g. an upstream the uninstall just removed
    svc.gate = () => false;
    expect(await svc.reconcile('git host')).toMatchObject({ unchanged: true, skipped: expect.stringMatching(/paused/) });
    expect(t.s.allowedTools['sofa-max']).toEqual(['erp__get_kpi', 'crm__list_customers']);
    svc.gate = () => true;
    await svc.reconcile();
    expect(t.s.allowedTools['sofa-max']).not.toEqual(['erp__get_kpi', 'crm__list_customers']); // main restored once open
  });

  it('a console edit in flight is not reverted by a reconcile (it is captured instead)', async () => {
    await svc.init(seed, 'ada@example.local');
    svc.beginEdit(); // the request started; the store changes before the capture
    t.s.allowedTools['sofa-max'] = ['erp__get_kpi', 'crm__list_customers'];
    expect(await svc.reconcile()).toMatchObject({ deferred: true });
    expect(t.s.allowedTools['sofa-max']).toEqual(['erp__get_kpi', 'crm__list_customers']);
    await svc.capture('ben@example.local', 'PUT /api/agents/sofa-max/tools');
    svc.endEdit();
    expect(await svc.reconcile()).toMatchObject({ unchanged: true });
    expect(t.s.allowedTools['sofa-max']).toEqual(['erp__get_kpi', 'crm__list_customers']);
  });

  it('an approved agent proposal changes the allow-list within one reconcile; rejection leaves main unchanged', async () => {
    await svc.init(seed, 'ada@example.local');
    const before = await svc.git.rev('main');
    const files = exportState(t.current());
    const next = files['gateway/allow-lists.yaml']!.replace('- erp__get_kpi', '- erp__get_kpi\n    - erp__list_suppliers');
    const p = await svc.propose({ title: 'Max may list suppliers', reason: 'needed for capacity planning', changes: [{ path: 'gateway/allow-lists.yaml', content: next }], author: { kind: 'agent', id: 'sofa-max', user: 'stefan@example.local', task: 't-1' } });
    expect(p.validation.ok).toBe(true);
    expect(p.paths).toEqual(['gateway/allow-lists.yaml']);
    expect(p.owners).toEqual([{ for: 'gateway/allow-lists.yaml', owners: ['role:Platform.Admin'] }]);
    expect((await svc.get(p.id)).diff).toMatch(/\+ {4}- erp__list_suppliers/);
    expect(await svc.git.rev('main')).toBe(before);

    await expect(svc.decide(p.id, 'approve', { email: 'stefan@example.local', roles: ['Platform.Admin'] })).rejects.toThrow(/four eyes/);
    await expect(svc.decide(p.id, 'approve', { email: 'eve@example.local', roles: [] })).rejects.toThrow(/not an owner/);
    const done = await svc.decide(p.id, 'approve', ADMIN, 'ok');
    expect(done.status).toBe('approved');
    expect(t.s.allowedTools['sofa-max']).toEqual(['erp__get_kpi', 'erp__list_suppliers']);
    const [merge] = (await svc.status()).log;
    expect(merge!.body).toMatch(/Approved-By: ada@example.local/);
    expect(merge!.body).toMatch(/Agent: sofa-max/);
    await expect(svc.decide(p.id, 'reject', ADMIN)).rejects.toThrow(/already approved/);

    const head = await svc.git.rev('main');
    const q = await svc.propose({ title: 'Lara gets everything', reason: 'convenience', changes: [{ path: 'gateway/allow-lists.yaml', content: next.replace('- erp__*', '- "*"') }], author: { kind: 'agent', id: 'sofa-lara' } });
    expect((await svc.decide(q.id, 'reject', ADMIN, 'no')).status).toBe('rejected');
    expect(await svc.git.rev('main')).toBe(head);
  });

  it('a playbook that loosens automatically is invalid (tighten-only rule)', async () => {
    await svc.init(seed, 'ada@example.local');
    const bad = await svc.propose({ title: 'auto restore', reason: 'faster', changes: [{ path: 'playbooks/x.yaml', content: PLAYBOOK.replace('type: notify, autonomy: auto, with: { subject: hello }', 'type: restore, autonomy: auto') }], author: { kind: 'agent', id: 'sofa-max' } });
    expect(bad.validation.ok).toBe(false);
    expect(JSON.stringify(bad.validation.checks)).toMatch(/must have autonomy/);
  });

  it('an invalid proposal cannot be approved; secrets and paths outside the layout are refused', async () => {
    await svc.init(seed, 'ada@example.local');
    const bad = await svc.propose({ title: 'broken', reason: 'typo', changes: [{ path: 'gateway/allow-lists.yaml', content: 'allowedTools: [1, 2]\n' }], author: { kind: 'person', id: 'ben@example.local' } });
    expect(bad.validation.ok).toBe(false);
    await expect(svc.decide(bad.id, 'approve', ADMIN)).rejects.toThrow(/does not validate/);
    await expect(svc.propose({ title: 'leak', reason: 'oops', changes: [{ path: 'playbooks/x.yaml', content: `token: ${SECRET}\n` }], author: { kind: 'agent', id: 'sofa-lara' } })).rejects.toThrow(/secret values/);
    await expect(svc.propose({ title: 'escape', reason: 'nope', changes: [{ path: 'gateway/../../etc/passwd', content: 'x' }], author: { kind: 'agent', id: 'sofa-lara' } })).rejects.toThrow(/outside/);
  });

  it('a proposal whose file changed on main meanwhile is a conflict; a non-overlapping one merges', async () => {
    await svc.init(seed, 'ada@example.local');
    const files = exportState(t.current());
    const a = await svc.propose({ title: 'Option A', reason: 'reason a', changes: [{ path: 'gateway/allow-lists.yaml', content: files['gateway/allow-lists.yaml']!.replace('erp__get_kpi', 'erp__get_state') }], author: { kind: 'agent', id: 'sofa-max' } });
    const b = await svc.propose({ title: 'Option B', reason: 'reason b', changes: [{ path: 'gateway/allow-lists.yaml', content: files['gateway/allow-lists.yaml']!.replace('erp__get_kpi', 'erp__get_log') }], author: { kind: 'agent', id: 'sofa-max' } });
    const c = await svc.propose({ title: 'Option C', reason: 'reason c', changes: [{ path: 'playbooks/x.yaml', content: PLAYBOOK }], author: { kind: 'agent', id: 'sofa-max' } });
    await svc.decide(a.id, 'approve', ADMIN);
    await expect(svc.decide(b.id, 'approve', ADMIN)).rejects.toThrow(/conflicts/);
    expect((await svc.decide(c.id, 'approve', ADMIN)).status).toBe('approved');
    expect((await allowList())['sofa-max']).toEqual(['erp__get_state']);
    expect(Object.keys(await svc.git.files('main'))).toContain('playbooks/x.yaml');
  });
});

describe('ontology changes (M8)', () => {
  const baseIr = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/ontology-sofa/ir/ontology.ir.json'), 'utf8')) as OntologyIr;
  const variant = (schema: string): OntologyIr => {
    const ir = structuredClone(baseIr);
    if (schema.includes('# carrier')) {
      ir.version = schema.includes('# v0.2.0') ? '0.2.0' : '0.1.0';
      ir.classes.push({ name: 'Carrier', identifier: 'id', annotations: { criticality: 'normal', data_class: 'internal', owner: 'head-of-logistics' }, attributes: [{ name: 'id', range: 'string', rangeKind: 'type', required: true, multivalued: false, identifier: true }] });
    }
    if (schema.includes('# drop-note')) {
      ir.version = '1.0.0';
      const po = ir.classes.find((c) => c.name === 'PurchaseOrder')!;
      po.attributes = po.attributes.filter((a) => a.name !== 'note');
    }
    return ir;
  };
  const ontoSeed = { 'ontology/sofa/schema.yaml': 'schema\n', 'ontology/sofa/actions.yaml': 'actions\n', 'ontology/sofa/bindings.yaml': 'bindings\n' };
  const applied: string[] = [];
  const mk = async () => {
    const s2 = new ConfigRepoService(dir, t, { compileOntology: async (f) => ({ ok: true, ir: variant(f['schema.yaml']!) }), checkOntology: async () => ({ data: { ok: true, findings: [] } }) });
    await s2.load();
    s2.onOntology = async (d, f) => {
      applied.push(`${d}:${variant(f['schema.yaml']).version}`);
      return `ontology ${d} applied`;
    };
    await s2.init({ ...seed, ...ontoSeed }, 'ada@example.local');
    return s2;
  };

  it('compatibility class, version bump and migration note gate the proposal', async () => {
    const s2 = await mk();
    const minorNoBump = await s2.propose({ title: 'Carriers', reason: 'D3 carriers', changes: [{ path: 'ontology/sofa/schema.yaml', content: 'schema\n# carrier\n' }], author: { kind: 'person', id: 'ben@x' } });
    expect(minorNoBump.compat?.level).toBe('minor');
    expect(minorNoBump.validation.ok).toBe(false);
    expect(minorNoBump.validation.checks.find((c) => c.name.endsWith('version'))?.detail).toMatch(/at least 0.2.0/);
    const minor = await s2.propose({ title: 'Carriers', reason: 'D3 carriers', changes: [{ path: 'ontology/sofa/schema.yaml', content: 'schema\n# carrier\n# v0.2.0\n' }], author: { kind: 'person', id: 'ben@x' } });
    expect(minor.validation.ok).toBe(true);
    const major = await s2.propose({ title: 'Drop note', reason: 'unused', changes: [{ path: 'ontology/sofa/schema.yaml', content: 'schema\n# drop-note\n' }], author: { kind: 'person', id: 'ben@x' } });
    expect(major.compat?.level).toBe('major');
    expect(major.validation.checks.find((c) => c.name.includes('compatibility'))).toMatchObject({ ok: false });
    const withNote = await s2.propose({ title: 'Drop note', reason: 'unused', migrationNote: 'notes were never read; history keeps them', changes: [{ path: 'ontology/sofa/schema.yaml', content: 'schema\n# drop-note\n' }], author: { kind: 'person', id: 'ben@x' } });
    expect(withNote.validation.ok).toBe(true);
    const v = await s2.validateChanges([{ path: 'ontology/sofa/schema.yaml', content: 'schema\n# carrier\n# v0.2.0\n' }]);
    expect(v).toMatchObject({ valid: true, compatibility: { level: 'minor' } });
    expect(await s2.git.rev('refs/liquid/validate-x')).toBeNull();
  });

  it('the reconciler applies a changed ontology once, after approval', async () => {
    applied.length = 0;
    const s2 = await mk();
    await s2.reconcile();
    expect(applied).toEqual(['sofa:0.1.0']); // first reconcile: the running version is confirmed once
    await s2.reconcile();
    expect(applied).toHaveLength(1);
    const p = await s2.propose({ title: 'Carriers', reason: 'D3 carriers', changes: [{ path: 'ontology/sofa/schema.yaml', content: 'schema\n# carrier\n# v0.2.0\n' }], author: { kind: 'agent', id: 'sofa-modeller' } });
    await s2.decide(p.id, 'approve', ADMIN);
    expect(applied).toEqual(['sofa:0.1.0', 'sofa:0.2.0']);
    expect((await s2.status()).lastReconcile?.changes).toContain('ontology sofa applied');
  });
});
