import { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { irHash, type OntologyIr } from '@cw/ontology-ir';
import { loadIr, types } from '@cw/ontology-sofa';
import { PARITY_CALLS, SCENARIO_IDS, SofaCompany, type Args } from '@cw/sofa-domain';
import { rpc, toolsFor } from './mcp.js';
import { OntologyService, type PolicyHook } from './service.js';

/* The action pipeline against Postgres (PGlite, no Docker), with the same type parsing as production. */

type MockTool = { name: string; run: (a: Args) => { content: Array<{ text: string }>; isError?: boolean } };
// @ts-expect-error plain .mjs without types; importing does not start the mock server
const mock = (await import('../../../scripts/sofa-company/mock-mcp.mjs')) as { SERVERS: Record<string, { tools: MockTool[] }>; mockControl: { reset(): void; scenario(id: string): void; kpi(): unknown } };
const mockTools = new Map(Object.values(mock.SERVERS).flatMap((s) => s.tools.map((t) => [t.name, t] as const)));
const callMock = (name: string, a: Args) => {
  const t = mockTools.get(name);
  if (!t) return { text: `Unknown tool ${name}`, isError: true };
  try {
    const out = t.run(a);
    return { text: out.content[0]!.text, isError: !!out.isError };
  } catch (e) {
    return { text: `Tool failed: ${(e as Error).message}`, isError: true };
  }
};
const norm = (s: string) => s.replace(/"at": "[^"]+"/g, '"at": "<t>"');

let db: PGlite;
let failOn: RegExp | undefined;
function poolOf(d: PGlite): pg.Pool {
  const query = async (text: string, params?: unknown[]) => {
    if (failOn?.test(text)) throw new Error('injected failure');
    if (!params?.length && text.split(';').filter((s) => s.trim()).length > 1) {
      await d.exec(text);
      return { rows: [] };
    }
    return d.query(text, params);
  };
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool;
}
const events = async () => Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM events')).rows[0]!.n);

let svc: OntologyService;
beforeEach(async () => {
  failOn = undefined;
  db = new PGlite({ parsers: { 1082: (v: string) => v, 20: (v: string) => Number(v), 1184: (v: string) => new Date(v).toISOString(), 701: (v: string) => Number(v) } });
  svc = new OntologyService(poolOf(db), loadIr());
  await svc.init();
});

describe('initialisation', () => {
  it('seeds T0 once and loads the same state', async () => {
    expect(svc.company.kpi()).toEqual(new SofaCompany().kpi());
    const again = new OntologyService(poolOf(db), loadIr());
    await again.init();
    expect(JSON.stringify(again.company.W)).toBe(JSON.stringify(svc.company.W));
    expect(await events()).toBe(0);
  });
  it('the seeded projection passes every generated data-quality check (M2 criterion)', async () => {
    const r = await svc.dq();
    expect(r.failed).toEqual([]);
    expect(r.checks).toBeGreaterThan(40);
  });
});

describe('action pipeline', () => {
  it('read-only actions never write', async () => {
    for (const a of loadIr().actions.filter((x) => x.readOnly)) await svc.execute(a.name, a.name === 'get_capacity' ? { factory: 'F-NORTH' } : a.name === 'get_material_projection' ? { sku: 'FOAM-HR35' } : a.name === 'get_order' ? { orderId: 'SO-2101' } : {});
    expect(await events()).toBe(0);
  });

  it('invalid input is rejected by the generated schema, nothing is written', async () => {
    const out = await svc.execute('request_overtime', { factory: 'F-NORTH', from: 'next monday', to: '2026-10-09' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Invalid input for request_overtime: from:/);
    expect(await events()).toBe(0);
  });

  it('a failed precondition answers like the mock and writes nothing', async () => {
    const out = await svc.execute('create_purchase_order', { supplierId: 'S-SILESIA', sku: 'BEAM-PINE-80', quantity: 99999 });
    expect(out).toEqual({ text: 'Quantity must be between 500 and 3000 for S-SILESIA', isError: true });
    expect(await events()).toBe(0);
  });

  it('a write appends one event with input, answer, changes and caller, and updates the projection', async () => {
    const out = await svc.execute('create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 }, { agent: 'sofa-lara', task: 'task-1', user: 'stefan@x' });
    expect(out.isError).toBe(false);
    const e = (await db.query<{ seq: number; type: string; object_type: string; object_id: string; action: string; actor_agent: string; actor_user: string; task_id: string; payload: { changes: Array<{ class: string; id: string }>; log: { tool: string } } }>('SELECT * FROM events')).rows;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ seq: out.seq, type: 'PurchaseOrderCreated', object_type: 'PurchaseOrder', object_id: 'PO-4430', action: 'create_purchase_order', actor_agent: 'sofa-lara', actor_user: 'stefan@x', task_id: 'task-1' });
    expect(e[0]!.payload.changes.map((c) => `${c.class}:${c.id}`)).toEqual(['PurchaseOrder:PO-4430']);
    expect(e[0]!.payload.log.tool).toBe('erp.create_purchase_order');
    const row = (await db.query<{ qty: number; updated_seq: number; version: number }>("SELECT qty, updated_seq, version FROM projection.purchase_order WHERE id = 'PO-4430'")).rows[0];
    expect(row).toEqual({ qty: 2000, updated_seq: out.seq, version: 1 });
    expect(svc.company.W.purchaseOrders.at(-1)!.id).toBe('PO-4430');
  });

  it('a failing transaction rolls back: no event, no projection change, in-memory state unchanged', async () => {
    const before = JSON.stringify(svc.company.W);
    failOn = /INSERT INTO projection\.purchase_order/;
    await expect(svc.execute('create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 })).rejects.toThrow(/injected/);
    failOn = undefined;
    expect(JSON.stringify(svc.company.W)).toBe(before);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM projection.purchase_order WHERE id = 'PO-4430'")).rows[0]!.n).toBe(0);
  });

  it('the policy hook can deny (fail closed); no business change, the denial is an event', async () => {
    const deny: PolicyHook = async () => ({ allow: false, reason: 'tools_off' });
    const s2 = new OntologyService(poolOf(db), loadIr(), deny);
    await s2.init();
    const out = await s2.execute('cancel_purchase_order', { poId: 'PO-4411', reason: 'x' });
    expect(out).toMatchObject({ isError: true, denied: true, text: 'Denied by policy: tools_off' });
    const ev = (await db.query<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM events')).rows;
    expect(ev).toMatchObject([{ type: 'PolicyDecision', payload: { point: 'object', allow: false, reason: 'tools_off' } }]);
    expect(ev[0]!.payload.changes).toBeUndefined();
  });
});

describe.each(['baseline', ...SCENARIO_IDS])('parity through the pipeline: %s', (scenario) => {
  it('answers equal the mock; inputs the generated schema rejects are listed', async () => {
    mock.mockControl.reset();
    if (scenario !== 'baseline') {
      mock.mockControl.scenario(scenario);
      await svc.scenario(scenario);
    }
    const rejected: string[] = [];
    for (const [name, args] of PARITY_CALLS) {
      const schema = (types.ACTION_INPUTS as Record<string, { safeParse(v: unknown): { success: boolean } }>)[name];
      if (schema && !schema.safeParse(args).success) {
        rejected.push(`${name} ${JSON.stringify(args)}`);
        expect((await svc.execute(name, structuredClone(args))).isError).toBe(true);
        continue;
      }
      const m = callMock(name, structuredClone(args));
      const o = await svc.execute(name, structuredClone(args));
      expect(norm(o.text), `${name} ${JSON.stringify(args)}`).toBe(norm(m.text));
    }
    // stricter than the mock only where the mock's own tool schema already forbids the input
    expect(rejected).toEqual(['get_capacity {"factory":"F-NOPE"}']);
    expect(svc.company.kpi()).toEqual(mock.mockControl.kpi());
  });
});

describe('projection rebuild, reset, write log', () => {
  it('rebuilding from T0 + events gives an identical projection and the same answers', async () => {
    await svc.scenario('storm');
    for (const [name, args] of PARITY_CALLS.slice(25, 50)) await svc.execute(name, structuredClone(args), { agent: 'sofa-tom' });
    const kpi = svc.company.kpi();
    const dry = await svc.rebuild({ dryRun: true });
    expect(dry.identical).toBe(true);
    expect(dry.eventsApplied).toBe(await events());
    const swapped = await svc.rebuild();
    expect(swapped).toMatchObject({ identical: true, swapped: true });
    expect(svc.company.kpi()).toEqual(kpi);
    expect((await svc.dq()).failed).toEqual([]);
  });

  it('reset restores T0 as an event; the write log starts again', async () => {
    await svc.scenario('supplier-beams');
    await svc.execute('request_overtime', { factory: 'F-NORTH', from: '2026-10-06', to: '2026-10-09' });
    expect((await svc.writeLog()).map((l) => l.tool)).toEqual(['erp.request_overtime']);
    await svc.reset();
    expect(svc.company.kpi()).toEqual(new SofaCompany().kpi());
    expect(await svc.writeLog()).toEqual([]);
    await svc.execute('request_overtime', { factory: 'F-SOUTH', from: '2026-10-06', to: '2026-10-07' });
    expect((await svc.writeLog())[0]).toMatchObject({ tool: 'erp.request_overtime', args: { factory: 'F-SOUTH', from: '2026-10-06', to: '2026-10-07' }, result: '2 days' });
    expect((await svc.rebuild({ dryRun: true })).identical).toBe(true);
  });
});

describe('MCP', () => {
  it('groups: erp + crm + ungrouped (onto only) = onto; caller fields are declared for the gateway', () => {
    expect(toolsFor(loadIr(), 'erp').length + toolsFor(loadIr(), 'crm').length + 1).toBe(toolsFor(loadIr(), 'onto').length);
    expect(toolsFor(loadIr(), 'onto').map((t) => t.name)).toContain('release_purchase_order');
    expect(Object.keys(toolsFor(loadIr(), 'erp')[0]!.inputSchema.properties)).toEqual(expect.arrayContaining(['_agent', '_task', '_requestedBy']));
  });
  it('tools/call through JSON-RPC records the caller the gateway injected', async () => {
    const out = (await rpc(svc, 'crm', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_delivery_date', arguments: { orderId: 'SO-2105', newDate: '2026-11-06', reason: 'x', _agent: 'sofa-horst', _task: 't-9', _requestedBy: 'sabine@x' } } })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(out.result.isError).toBeUndefined();
    expect(JSON.parse(out.result.content[0]!.text).communicatedDelivery).toBe('2026-11-06');
    const e = (await db.query<{ actor_agent: string; task_id: string; actor_user: string; payload: { input: Args } }>('SELECT actor_agent, task_id, actor_user, payload FROM events')).rows[0]!;
    expect(e).toMatchObject({ actor_agent: 'sofa-horst', task_id: 't-9', actor_user: 'sabine@x' });
    expect(e.payload.input).toEqual({ orderId: 'SO-2105', newDate: '2026-11-06', reason: 'x' });
  });
  it('an approval cannot come from an agent: _approvedBy in an MCP call is dropped', async () => {
    let seen: unknown;
    const s2 = new OntologyService(poolOf(db), loadIr(), async ({ caller }) => {
      seen = caller;
      return { allow: true };
    });
    await s2.init();
    await rpc(s2, 'erp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_kpi', arguments: { _agent: 'sofa-lara', _approvedBy: 'ben@x', _workflow: 'fake' } } });
    expect(seen).toEqual({ agent: 'sofa-lara' });
  });

  it('a tool of another group is unknown in this group', async () => {
    const out = (await rpc(svc, 'erp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_customers', arguments: {} } })) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(out.result).toMatchObject({ isError: true, content: [{ text: 'Unknown tool list_customers' }] });
  });
});

describe('shadow replay (M7)', () => {
  const work = async () => {
    await svc.execute('create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 }, { agent: 'sofa-lara' });
    await svc.scenario('supplier-beams');
    await svc.execute('request_overtime', { factory: 'F-NORTH', from: '2026-10-06', to: '2026-10-07' }, { agent: 'sofa-max' });
    await svc.execute('create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 3000 }, { agent: 'sofa-lara' });
  };
  it('with the actual configuration nothing diverges and the KPIs are equal', async () => {
    await work();
    const r = await svc.shadowReplay({ fromSeq: 1 });
    expect(r).toMatchObject({ actions: 3, replayed: 3, blocked: 0, diverged: 0 });
    expect(Object.values(r.kpi.delta).every((v) => v === 0)).toBe(true);
  });
  it('a candidate that requires four eyes on purchase orders reports the blocked actions; same input, same report', async () => {
    await work();
    const candidate = { overlays: [{ effect: 'require_four_eyes' as const, match: { actions: ['create_purchase_order'] } }] };
    const a = await svc.shadowReplay({ fromSeq: 1, candidate });
    expect(a).toMatchObject({ blocked: 2, needsApproval: 2, replayed: 1 });
    expect(a.blockedActions.map((b) => b.agent)).toEqual(['sofa-lara', 'sofa-lara']);
    const b = await svc.shadowReplay({ fromSeq: 1, candidate });
    expect(b.reportHash).toBe(a.reportHash);
    expect((await svc.shadowReplay({ fromSeq: 1 })).reportHash).not.toBe(a.reportHash);
  });
});

describe('ontology evolution (M8)', () => {
  const d3 = (): OntologyIr => {
    const ir = structuredClone(loadIr()) as OntologyIr;
    ir.version = '0.2.0';
    ir.classes.push({ name: 'Carrier', identifier: 'id', annotations: { criticality: 'normal', data_class: 'internal', owner: 'head-of-logistics' }, attributes: [{ name: 'id', range: 'string', rangeKind: 'type', required: true, multivalued: false, identifier: true }, { name: 'name', range: 'string', rangeKind: 'type', required: true, multivalued: false, identifier: false }] });
    ir.classes.find((c) => c.name === 'PurchaseOrder')!.attributes.push({ name: 'carrier', range: 'Carrier', rangeKind: 'class', required: false, multivalued: false, identifier: false });
    ir.links.push({ from: 'PurchaseOrder', attribute: 'carrier', to: 'Carrier', required: false, multivalued: false });
    ir.events.push({ name: 'CarrierCreated', objectType: 'Carrier' }, { name: 'PurchaseOrderCarrierAssigned', objectType: 'PurchaseOrder' });
    ir.actions.push(
      { name: 'list_carriers', description: 'Carriers', target: 'Carrier', kind: 'query', readOnly: true, destructive: false, input: [{ name: 'name', range: 'string', rangeKind: 'type', required: false, multivalued: false }], preconditions: [], emits: [] },
      { name: 'create_carrier', description: 'New carrier', target: 'Carrier', kind: 'create', readOnly: false, destructive: false, input: [{ name: 'name', range: 'string', rangeKind: 'type', required: true, multivalued: false }], preconditions: [], emits: ['CarrierCreated'] },
      { name: 'assign_carrier', description: 'Carrier of a PO', target: 'PurchaseOrder', kind: 'update', readOnly: false, destructive: false, input: [{ name: 'poId', range: 'PurchaseOrder', rangeKind: 'class', required: true, multivalued: false }, { name: 'carrierId', range: 'Carrier', rangeKind: 'class', required: true, multivalued: false }], preconditions: [], emits: ['PurchaseOrderCarrierAssigned'] },
    );
    ir.hash = irHash(ir);
    return ir;
  };

  it('the D3 change goes live without a restart: new tools, generic actions, projection migrated, no event lost', async () => {
    await svc.execute('create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 });
    const before = await events();
    const next = d3();
    expect((await svc.check(next)).compatibility.level).toBe('minor');
    const out = await svc.apply(next, { note: 'D3: carriers' });
    expect(out).toMatchObject({ applied: true, from: '0.1.0', to: '0.2.0', level: 'minor', migration: 'alter' });
    expect(await events()).toBe(before + 1);
    expect(toolsFor(svc.ir, 'onto').map((t) => t.name)).toEqual(expect.arrayContaining(['list_carriers', 'create_carrier', 'assign_carrier']));
    const c = await svc.execute('create_carrier', { name: 'Nordfracht' }, { agent: 'sofa-lara' });
    expect(c.isError).toBe(false);
    const carrierId = JSON.parse(c.text).id as string;
    expect((await svc.execute('assign_carrier', { poId: 'PO-4430', carrierId }, { agent: 'sofa-lara' })).isError).toBe(false);
    expect((await svc.execute('assign_carrier', { poId: 'PO-4430', carrierId: 'NOPE' })).text).toMatch(/Unknown Carrier NOPE/);
    expect(JSON.parse((await svc.execute('list_carriers', {})).text)).toEqual([{ id: carrierId, name: 'Nordfracht' }]);
    expect(svc.objects().PurchaseOrder!.find((p) => p.id === 'PO-4430')!.carrier).toBe(carrierId);
    const row = await db.query<{ carrier: string }>("SELECT carrier FROM projection.purchase_order WHERE id = 'PO-4430'");
    expect(row.rows[0]!.carrier).toBe(carrierId);
    const ev = await db.query<{ ontology_version: string }>("SELECT ontology_version FROM events WHERE type = 'CarrierCreated'");
    expect(ev.rows[0]).toMatchObject({ ontology_version: '0.2.0' });
    expect((await svc.execute('create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 1000 })).isError).toBe(false);
    expect((await svc.rebuild({ dryRun: true })).identical).toBe(true);
    const again = new OntologyService(poolOf(db), loadIr());
    await again.init();
    expect(again.ir.version).toBe('0.2.0');
    expect(again.objects().Carrier).toHaveLength(1);
    expect(again.objects().PurchaseOrder!.find((p) => p.id === 'PO-4430')!.carrier).toBe(carrierId);
  });

  it('a rename keeps the old name as a deprecated alias that still works and is recorded', async () => {
    const next = d3();
    const a = next.actions.find((x) => x.name === 'list_suppliers')!;
    a.name = 'find_suppliers';
    a.aliases = ['list_suppliers'];
    next.hash = irHash(next);
    await svc.apply(next);
    const tools = toolsFor(svc.ir, 'onto');
    expect(tools.find((t) => t.name === 'list_suppliers')!.description).toMatch(/^DEPRECATED alias of find_suppliers/);
    expect((await svc.execute('list_suppliers', { sku: 'BEAM-PINE-80' })).isError).toBe(false);
  });

  it('a breaking change needs the go-ahead and rebuilds the projection from the events', async () => {
    await svc.apply(d3());
    await svc.execute('create_carrier', { name: 'Nordfracht' });
    const broken = structuredClone(svc.ir);
    broken.version = '1.0.0';
    broken.classes = broken.classes.filter((c) => c.name !== 'Carrier');
    const po = broken.classes.find((c) => c.name === 'PurchaseOrder')!;
    po.attributes = po.attributes.filter((x) => x.name !== 'carrier');
    broken.links = broken.links.filter((l) => l.to !== 'Carrier');
    broken.actions = broken.actions.filter((x) => !['list_carriers', 'create_carrier', 'assign_carrier'].includes(x.name));
    broken.events = broken.events.filter((e) => !['CarrierCreated', 'PurchaseOrderCarrierAssigned'].includes(e.name));
    broken.hash = irHash(broken);
    const check = await svc.check(broken);
    expect(check.compatibility.level).toBe('major');
    expect(check.data.findings.map((f) => f.path)).toContain('Carrier');
    await expect(svc.apply(broken)).rejects.toThrow(/needs a migration note/);
    const out = await svc.apply(broken, { allowBreaking: true, note: 'carriers moved to the logistics system' });
    expect(out).toMatchObject({ level: 'major', migration: 'rebuild', to: '1.0.0' });
    expect(svc.objects().Carrier).toBeUndefined();
    const t = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'projection' AND table_name = 'carrier'");
    expect(t.rows[0]!.n).toBe(0);
    expect(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE type = 'CarrierCreated'")).rows[0]!.n)).toBe(1);
    expect((await svc.execute('list_suppliers', {})).isError).toBe(false);
  });

  it('a class that comes back is backfilled from its events (live state = rebuild)', async () => {
    const first = d3();
    await svc.apply(first);
    const old = JSON.parse((await svc.execute('create_carrier', { name: 'Old Carrier' })).text).id as string;
    const without = structuredClone(svc.ir);
    without.version = '1.0.0';
    without.classes = without.classes.filter((c) => c.name !== 'Carrier');
    const po = without.classes.find((c) => c.name === 'PurchaseOrder')!;
    po.attributes = po.attributes.filter((x) => x.name !== 'carrier');
    without.links = without.links.filter((l) => l.to !== 'Carrier');
    without.actions = without.actions.filter((x) => !['list_carriers', 'create_carrier', 'assign_carrier'].includes(x.name));
    without.events = without.events.filter((e) => !['CarrierCreated', 'PurchaseOrderCarrierAssigned'].includes(e.name));
    without.hash = irHash(without);
    await svc.apply(without, { allowBreaking: true, note: 'gone' });
    const back = structuredClone(first);
    back.version = '1.1.0';
    back.hash = irHash(back);
    const out = await svc.apply(back);
    expect(out).toMatchObject({ level: 'minor', migration: 'rebuild' });
    expect(svc.objects().Carrier!.map((c) => c.id)).toEqual([old]);
    const next = JSON.parse((await svc.execute('create_carrier', { name: 'New Carrier' })).text).id as string;
    expect(next).not.toBe(old);
    expect((await svc.rebuild({ dryRun: true })).identical).toBe(true);
  });
});
