import { CAMPAIGN_SALES, PRODUCTS, SALES, SKU, type Sequences } from './world.js';
import type { CompanyWorld } from './company.js';

/*
 * The world of the sofa company as ontology objects (plan M3): one row per object, keyed by the attribute names of
 * ontology/sofa/schema.yaml, links as ids, plus `ord` (insertion order). This is what the projection stores and what
 * events carry in `changes`. `objectsToWorld` rebuilds exactly the world the domain logic works on (same values, same
 * key order, same list order), so answers stay byte-identical after a reload or a projection rebuild.
 */

export type Row = Record<string, string | number | boolean | null | string[]> & { ord: number };
export type Objects = Record<string, Row[]>;

/** Company-level values that are not objects of a class (kept next to the projection). */
export interface CompanyMeta {
  seq: Sequences;
  costEur: number;
  writtenOffEur: number | null;
  /** Scenarios started since the last reset (the mock's W.events). */
  scenarios: string[];
  writes: number;
}

export interface Change {
  class: string;
  id: string;
  /** The object after the change; null = deleted. */
  after: Row | null;
}

const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const ID: Record<string, string> = {
  Factory: 'id', Machine: 'id', Worker: 'id', Absence: 'id', OvertimeShift: 'id', TempWorkerAssignment: 'id', Material: 'sku', Bom: 'product', Supplier: 'id', InventoryItem: 'lot_id',
  PurchaseOrder: 'id', ProductionOrder: 'id', MaintenanceTicket: 'id', Incident: 'id', Customer: 'id', SalesOrder: 'id', CustomerNotice: 'id', Campaign: 'id', DemandSignal: 'sales_order_id',
};
export const identifierAttr = (cls: string) => ID[cls] ?? 'id';
export const SOFA_CLASSES = Object.keys(ID);

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function worldToObjects(W: CompanyWorld): Objects {
  const o: Objects = {};
  const put = (cls: string, rows: Array<Omit<Row, 'ord'>>) => (o[cls] = rows.map((r, i) => ({ ...r, ord: i }) as Row));
  put('Factory', Object.values(W.factories).map((f) => ({ id: f.id, name: f.name })));
  put('Machine', W.machines.map((m) => ({ id: m.id, factory: m.factory, name: m.name, rate_per_day: m.ratePerDay, status: m.status, down_since: m.downSince, note: m.note })));
  put('Worker', W.workers.map((w) => ({ id: w.id, name: w.name, factory: w.factory })));
  put('Absence', W.workers.flatMap((w) => w.absences.map((a, i) => ({ id: `${w.id}:${a.from}:${i}`, worker: w.id, date_from: a.from, date_to: a.to, reason: a.reason ?? null }))));
  put('OvertimeShift', W.overtime.map((x, i) => ({ id: `OT-${pad(i + 1)}`, factory: x.factory, date_from: x.from, date_to: x.to })));
  put('TempWorkerAssignment', W.temp.map((x, i) => ({ id: `TMP-${pad(i + 1)}`, factory: x.factory, count: x.count, date_from: x.from, date_to: x.to })));
  put('Material', Object.entries(SKU).map(([sku, s]) => ({ sku, name: s.name, unit: s.unit, unit_cost: s.cost })));
  put('Bom', Object.entries(PRODUCTS).map(([product, p]) => ({ product, product_name: p.name, beams: p.beams, fabric_m: p.fabricM, foam: p.foam })));
  put('Supplier', W.suppliers.map((s) => ({ id: s.id, name: s.name, skus: [...s.skus], lead_workdays: s.leadWorkdays, unit_price: s.unitPrice, min_qty: s.minQty, max_qty: s.maxQty, express_lead_workdays: s.expressLeadWorkdays, express_surcharge_per_unit: s.expressSurchargePerUnit, rating: s.rating, status: s.status, notice: s.notice })));
  put('InventoryItem', W.lots.map((l) => ({ lot_id: l.id, sku: l.sku, qty: l.qty, location: l.location, status: l.status, note: l.note })));
  put('PurchaseOrder', W.purchaseOrders.map((p) => ({ id: p.id, supplier: p.supplierId, sku: p.sku, qty: p.qty, unit_price: p.unitPrice, eta: p.eta, original_eta: p.originalEta, status: p.status, express: p.express, note: p.note })));
  put('ProductionOrder', W.productionOrders.map((p) => ({ id: p.id, sales_order: p.salesOrderId, factory: p.factory, product: p.product, fabric: p.fabric, qty: p.qty, priority: p.priority, due_date: p.dueDate, status: p.status })));
  put('MaintenanceTicket', W.tickets.map((t: AnyObj) => ({ id: t.id, machine: t.machineId, status: t.status, required_part: t.requiredPart ?? null, description: t.description ?? null, technician_booked: t.technicianBooked ?? null, opened_at: t.openedAt ?? null })));
  put('Incident', (W.incidents as AnyObj[]).map((i) => ({ id: i.id, type: String(i.type), description: String(i.description), estimated_loss_eur: Number(i.estimatedLossEur), claim: i.claim ?? null, filed_at: i.filedAt ?? null })));
  put('Customer', W.customers.map((c) => ({ id: c.id, name: c.name, tier: c.tier, penalty_pct_per_week_late: c.penaltyPctPerWeekLate, contact: c.contact })));
  put('SalesOrder', W.salesOrders.map((s: AnyObj) => ({ id: s.id, customer: s.customerId, product: s.product, qty: s.qty, fabric: s.fabric, promised_delivery: s.promisedDelivery, communicated_delivery: s.communicatedDelivery, status: s.status, source: s.source ?? null })));
  put('CustomerNotice', (W.customerNotices as AnyObj[]).map((n, i) => ({ id: `CN-${pad(i + 1, 4)}`, customer: n.customerId, orders: [...(n.orderIds ?? [])], subject: n.subject, body: n.body, recipient: n.to, sent_at: n.at })));
  put('Campaign', W.campaigns.map((c) => ({ id: c.id, name: c.name, date_from: c.from, date_to: c.to, status: c.status, daily_budget_pct: c.dailyBudgetPct, note: c.note })));
  put('DemandSignal', SALES.map(([id, customerId, product, qty, , promised]) => ({ sales_order_id: id, customer: customerId, product, qty, promised_delivery: promised, source: 'plan' })));
  return o;
}

export const metaOf = (W: CompanyWorld, seq: Sequences, writes: number): CompanyMeta => ({ seq: { ...seq }, costEur: W.costEur, writtenOffEur: W.writtenOffEur ?? null, scenarios: [...W.events], writes });

const byOrd = (rows: Row[] | undefined) => [...(rows ?? [])].sort((a, b) => a.ord - b.ord);

/** Rebuilds the domain world from objects and company values (exact inverse of worldToObjects + metaOf). */
export function objectsToWorld(o: Objects, meta: CompanyMeta): { world: CompanyWorld; seq: Sequences; writes: number } {
  const r = (cls: string) => byOrd(o[cls]) as AnyObj[];
  const absences = r('Absence');
  const W: CompanyWorld = {
    factories: Object.fromEntries(r('Factory').map((f) => [f.id, { id: f.id, name: f.name }])) as CompanyWorld['factories'],
    machines: r('Machine').map((m) => ({ id: m.id, factory: m.factory, name: m.name, ratePerDay: m.rate_per_day, status: m.status, downSince: m.down_since, note: m.note })),
    workers: r('Worker').map((w) => ({ id: w.id, name: w.name, factory: w.factory, absences: absences.filter((a) => a.worker === w.id).map((a) => ({ from: a.date_from, to: a.date_to, reason: a.reason ?? undefined })) })),
    temp: r('TempWorkerAssignment').map((x) => ({ factory: x.factory, count: x.count, from: x.date_from, to: x.date_to })),
    overtime: r('OvertimeShift').map((x) => ({ factory: x.factory, from: x.date_from, to: x.date_to })),
    suppliers: r('Supplier').map((s) => ({ id: s.id, name: s.name, skus: [...s.skus], leadWorkdays: s.lead_workdays, unitPrice: s.unit_price, minQty: s.min_qty, maxQty: s.max_qty, expressLeadWorkdays: s.express_lead_workdays, expressSurchargePerUnit: s.express_surcharge_per_unit, rating: s.rating, status: s.status, notice: s.notice })),
    lots: r('InventoryItem').map((l) => ({ id: l.lot_id, sku: l.sku, qty: l.qty, location: l.location, status: l.status, note: l.note })),
    purchaseOrders: r('PurchaseOrder').map((p) => ({ id: p.id, supplierId: p.supplier, sku: p.sku, qty: p.qty, unitPrice: p.unit_price, eta: p.eta, originalEta: p.original_eta, status: p.status, express: p.express, note: p.note })),
    customers: r('Customer').map((c) => ({ id: c.id, name: c.name, tier: c.tier, penaltyPctPerWeekLate: c.penalty_pct_per_week_late, contact: c.contact })),
    salesOrders: r('SalesOrder').map((s) => ({ id: s.id, customerId: s.customer, product: s.product, qty: s.qty, fabric: s.fabric, promisedDelivery: s.promised_delivery, communicatedDelivery: s.communicated_delivery, status: s.status, ...(s.source != null ? { source: s.source } : {}) })),
    productionOrders: r('ProductionOrder').map((p) => ({ id: p.id, salesOrderId: p.sales_order, factory: p.factory, product: p.product, fabric: p.fabric, qty: p.qty, priority: p.priority, dueDate: p.due_date, status: p.status })),
    tickets: r('MaintenanceTicket').map((t) => ({ id: t.id, machineId: t.machine, description: t.description, requiredPart: t.required_part, status: t.status, technicianBooked: t.technician_booked, openedAt: t.opened_at })),
    campaigns: r('Campaign').map((c) => ({ id: c.id, name: c.name, from: c.date_from, to: c.date_to, status: c.status, dailyBudgetPct: c.daily_budget_pct, note: c.note })),
    incidents: r('Incident').map((i) => ({ id: i.id, type: i.type, description: i.description, estimatedLossEur: i.estimated_loss_eur, claim: i.claim, filedAt: i.filed_at })),
    customerNotices: r('CustomerNotice').map((n) => ({ at: n.sent_at, to: n.recipient, customerId: n.customer, orderIds: [...n.orders], subject: n.subject, body: n.body })),
    log: [],
    costEur: meta.costEur,
    events: [...meta.scenarios],
  };
  if (meta.writtenOffEur != null) W.writtenOffEur = meta.writtenOffEur;
  return { world: W, seq: { ...meta.seq }, writes: meta.writes };
}

const same = (a: Row, b: Row) => JSON.stringify(a) === JSON.stringify(b);

/** Objects that differ between two states (added or changed: after = row; removed: after = null). Stable order. */
export function diffObjects(before: Objects, after: Objects): Change[] {
  const out: Change[] = [];
  for (const cls of SOFA_CLASSES) {
    const key = identifierAttr(cls);
    const b = new Map((before[cls] ?? []).map((r) => [String(r[key]), r]));
    const a = new Map((after[cls] ?? []).map((r) => [String(r[key]), r]));
    for (const [id, row] of a) if (!b.has(id) || !same(b.get(id)!, row)) out.push({ class: cls, id, after: row });
    for (const id of b.keys()) if (!a.has(id)) out.push({ class: cls, id, after: null });
  }
  return out;
}

/** Applies changes to a set of objects (used by rebuild and the in-memory store). */
export function applyChanges(o: Objects, changes: Change[]): Objects {
  const next: Objects = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v]]));
  for (const c of changes) {
    const key = identifierAttr(c.class);
    const rows = (next[c.class] ??= []);
    const i = rows.findIndex((r) => String(r[key]) === c.id);
    if (c.after === null) {
      if (i >= 0) rows.splice(i, 1);
    } else if (i >= 0) rows[i] = c.after;
    else rows.push(c.after);
  }
  return next;
}

/** Event type and primary object of a scenario disruption (event catalog in ontology/sofa/actions.yaml). */
export const SCENARIO_EVENT: Record<string, { type: string; objectType: string; objectId: string }> = {
  'supplier-beams': { type: 'SupplierCannotDeliver', objectType: 'Supplier', objectId: 'S-NORDHOLZ' },
  'machine-failure': { type: 'MachineBrokeDown', objectType: 'Machine', objectId: 'N-CUT-1' },
  'demand-spike': { type: 'SalesOrderReceived', objectType: 'SalesOrder', objectId: CAMPAIGN_SALES[0]![0] },
  'sick-leave': { type: 'AbsenceReported', objectType: 'Absence', objectId: 'W-S1:2026-10-12:0' },
  storm: { type: 'LotQuarantined', objectType: 'InventoryItem', objectId: 'L-OAT-231' },
};
