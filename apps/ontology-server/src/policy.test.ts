import { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadIr } from '@cw/ontology-sofa';
import { worldToObjects, SofaCompany } from '@cw/sofa-domain';
import { opaPolicy, touchedObjects } from './policy.js';
import { OntologyService } from './service.js';

const ir = loadIr();

async function service(decision: unknown, status = 200) {
  const db = new PGlite({ parsers: { 1082: (v: string) => v, 20: (v: string) => Number(v), 1184: (v: string) => new Date(v).toISOString(), 701: (v: string) => Number(v) } });
  const query = async (text: string, params?: unknown[]) => {
    if (!params?.length && text.split(';').filter((s) => s.trim()).length > 1) {
      await db.exec(text);
      return { rows: [] };
    }
    return db.query(text, params);
  };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(decision), { status }));
  const svc = new OntologyService({ query, connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool, ir, opaPolicy(ir, { url: 'http://opa:8181', token: 't' }, fetchImpl as unknown as typeof fetch));
  await svc.init();
  return { svc, db, fetchImpl };
}

describe('touched objects', () => {
  it('resolves class-typed inputs with classification and status', () => {
    const c = worldToObjects(new SofaCompany().W);
    expect(touchedObjects(ir, 'cancel_purchase_order', { poId: 'PO-4411', reason: 'x' }, c)).toEqual([{ class: 'PurchaseOrder', id: 'PO-4411', criticality: 'payment_critical', data_class: 'confidential', owner: 'head-of-logistics', status: 'open' }]);
    expect(touchedObjects(ir, 'send_customer_notice', { customerId: 'C-01', orderIds: ['SO-2101', 'SO-2105'] }, c).map((o) => `${o.class}:${o.id}`)).toEqual(['Customer:C-01', 'SalesOrder:SO-2101', 'SalesOrder:SO-2105']);
    expect(touchedObjects(ir, 'get_kpi', {}, c)).toEqual([]);
  });
});

describe('object policy in the pipeline', () => {
  it('sends action, caller (incl. step) and objects to OPA', async () => {
    const { svc, fetchImpl } = await service({ result: { allow: true, reason: 'allowed', obligations: [] } });
    const out = await svc.execute('cancel_purchase_order', { poId: 'PO-4418', reason: 'x' }, { agent: 'sofa-lara', task: 't-1', step: 'run' });
    expect(out.isError).toBe(false);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.input).toMatchObject({ action: 'cancel_purchase_order', caller: { agent: 'sofa-lara', task: { id: 't-1', step: 'run' } }, objects: [{ class: 'PurchaseOrder', id: 'PO-4418', criticality: 'payment_critical' }] });
  });

  it('require_four_eyes: nothing changes, an approval request event is recorded', async () => {
    const { svc, db } = await service({ result: { allow: true, reason: 'allowed', obligations: ['require_four_eyes'] } });
    const before = JSON.stringify(svc.company.W);
    const out = await svc.execute('cancel_purchase_order', { poId: 'PO-4418', reason: 'x' }, { agent: 'sofa-lara' });
    expect(out).toMatchObject({ isError: true, denied: true });
    expect(out.text).toMatch(/^Pending approval \(four eyes\): cancel_purchase_order/);
    expect(JSON.stringify(svc.company.W)).toBe(before);
    const ev = (await db.query<{ type: string; action: string; actor_agent: string; payload: { changes?: unknown } }>('SELECT type, action, actor_agent, payload FROM events')).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'ActionApprovalRequested', action: 'cancel_purchase_order', actor_agent: 'sofa-lara' });
    expect(ev[0]!.payload.changes).toBeUndefined();
    expect((await svc.rebuild({ dryRun: true })).identical).toBe(true);
  });

  it('require_step_up and deny are refused', async () => {
    const a = await service({ result: { allow: true, obligations: ['require_step_up'] } });
    expect((await a.svc.execute('update_campaign', { campaignId: 'CMP-HERBST', dailyBudgetPct: 10 })).text).toMatch(/step-up/);
    const b = await service({ result: { allow: false, reason: 'overlay ov-1: frozen', obligations: [] } });
    expect(await b.svc.execute('get_kpi', {})).toMatchObject({ isError: true, denied: true, text: 'Denied by policy: overlay ov-1: frozen' });
  });

  it.each([
    ['HTTP 401', { error: 'x' }, 401, /HTTP 401/],
    ['no decision', {}, 200, /no decision/],
  ])('fail closed: %s', async (_n, body, status, reason) => {
    const { svc } = await service(body, status);
    const out = await svc.execute('get_kpi', {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(reason);
  });
});
