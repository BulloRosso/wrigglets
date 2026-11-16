import { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('the policy hook can deny (fail closed); nothing is written', async () => {
    const deny: PolicyHook = async () => ({ allow: false, reason: 'tools_off' });
    const s2 = new OntologyService(poolOf(db), loadIr(), deny);
    await s2.init();
    const out = await s2.execute('cancel_purchase_order', { poId: 'PO-4411', reason: 'x' });
    expect(out).toMatchObject({ isError: true, denied: true, text: 'Denied by policy: tools_off' });
    expect(await events()).toBe(0);
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
  it('groups: erp + crm = onto; caller fields are declared for the gateway', () => {
    expect(toolsFor('erp').length + toolsFor('crm').length).toBe(toolsFor('onto').length);
    expect(Object.keys(toolsFor('erp')[0]!.inputSchema.properties)).toEqual(expect.arrayContaining(['_agent', '_task', '_requestedBy']));
  });
  it('tools/call through JSON-RPC records the caller the gateway injected', async () => {
    const out = (await rpc(svc, 'crm', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_delivery_date', arguments: { orderId: 'SO-2105', newDate: '2026-11-06', reason: 'x', _agent: 'sofa-horst', _task: 't-9', _requestedBy: 'sabine@x' } } })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(out.result.isError).toBeUndefined();
    expect(JSON.parse(out.result.content[0]!.text).communicatedDelivery).toBe('2026-11-06');
    const e = (await db.query<{ actor_agent: string; task_id: string; actor_user: string; payload: { input: Args } }>('SELECT actor_agent, task_id, actor_user, payload FROM events')).rows[0]!;
    expect(e).toMatchObject({ actor_agent: 'sofa-horst', task_id: 't-9', actor_user: 'sabine@x' });
    expect(e.payload.input).toEqual({ orderId: 'SO-2105', newDate: '2026-11-06', reason: 'x' });
  });
  it('a tool of another group is unknown in this group', async () => {
    const out = (await rpc(svc, 'erp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_customers', arguments: {} } })) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(out.result).toMatchObject({ isError: true, content: [{ text: 'Unknown tool list_customers' }] });
  });
});
