import { PRODUCTS, SALES, SKU, type World } from './world.js';

/*
 * The sofa company's "source system extract": its ERP and CRM state as raw-zone tables (plan M1). Column names are
 * snake_case, types are DuckDB types. The bindings of the ontology (M2) map classes onto these tables.
 */

export type RawColumnType = 'VARCHAR' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'JSON';
export interface RawTable {
  /** Table name in schema raw, e.g. erp_suppliers. */
  name: string;
  /** Primary key column(s), for reading back in a stable order. */
  key: string[];
  columns: Array<{ name: string; type: RawColumnType }>;
  rows: Array<Record<string, string | number | boolean | null>>;
}

const t = (name: string, key: string[], columns: Array<[string, RawColumnType]>, rows: RawTable['rows']): RawTable => ({ name, key, columns: columns.map(([n, ty]) => ({ name: n, type: ty })), rows });

export function sofaExtract(w: World): RawTable[] {
  return [
    t('erp_factories', ['id'], [['id', 'VARCHAR'], ['name', 'VARCHAR']], Object.values(w.factories).map((f) => ({ id: f.id, name: f.name }))),
    t(
      'erp_machines',
      ['id'],
      [['id', 'VARCHAR'], ['factory_id', 'VARCHAR'], ['name', 'VARCHAR'], ['rate_per_day', 'BIGINT'], ['status', 'VARCHAR'], ['down_since', 'DATE'], ['note', 'VARCHAR']],
      w.machines.map((m) => ({ id: m.id, factory_id: m.factory, name: m.name, rate_per_day: m.ratePerDay, status: m.status, down_since: m.downSince, note: m.note })),
    ),
    t('erp_workers', ['id'], [['id', 'VARCHAR'], ['name', 'VARCHAR'], ['factory_id', 'VARCHAR']], w.workers.map((x) => ({ id: x.id, name: x.name, factory_id: x.factory }))),
    t(
      'erp_absences',
      ['worker_id', 'date_from'],
      [['worker_id', 'VARCHAR'], ['date_from', 'DATE'], ['date_to', 'DATE'], ['reason', 'VARCHAR']],
      w.workers.flatMap((x) => x.absences.map((a) => ({ worker_id: x.id, date_from: a.from, date_to: a.to, reason: a.reason ?? null }))),
    ),
    t('erp_materials', ['sku'], [['sku', 'VARCHAR'], ['name', 'VARCHAR'], ['unit', 'VARCHAR'], ['unit_cost', 'DOUBLE']], Object.entries(SKU).map(([sku, s]) => ({ sku, name: s.name, unit: s.unit, unit_cost: s.cost }))),
    t(
      'erp_bom',
      ['product'],
      [['product', 'VARCHAR'], ['product_name', 'VARCHAR'], ['beams', 'BIGINT'], ['fabric_m', 'DOUBLE'], ['foam', 'BIGINT']],
      Object.entries(PRODUCTS).map(([product, p]) => ({ product, product_name: p.name, beams: p.beams, fabric_m: p.fabricM, foam: p.foam })),
    ),
    t(
      'erp_suppliers',
      ['id'],
      [
        ['id', 'VARCHAR'], ['name', 'VARCHAR'], ['skus', 'JSON'], ['lead_workdays', 'BIGINT'], ['unit_price', 'DOUBLE'], ['min_qty', 'BIGINT'], ['max_qty', 'BIGINT'],
        ['express_lead_workdays', 'BIGINT'], ['express_surcharge_per_unit', 'DOUBLE'], ['rating', 'VARCHAR'], ['status', 'VARCHAR'], ['notice', 'VARCHAR'],
      ],
      w.suppliers.map((s) => ({
        id: s.id, name: s.name, skus: JSON.stringify(s.skus), lead_workdays: s.leadWorkdays, unit_price: s.unitPrice, min_qty: s.minQty, max_qty: s.maxQty,
        express_lead_workdays: s.expressLeadWorkdays, express_surcharge_per_unit: s.expressSurchargePerUnit, rating: s.rating, status: s.status, notice: s.notice,
      })),
    ),
    t(
      'erp_inventory',
      ['lot_id'],
      [['lot_id', 'VARCHAR'], ['sku', 'VARCHAR'], ['qty', 'DOUBLE'], ['location', 'VARCHAR'], ['status', 'VARCHAR'], ['note', 'VARCHAR']],
      w.lots.map((l) => ({ lot_id: l.id, sku: l.sku, qty: l.qty, location: l.location, status: l.status, note: l.note })),
    ),
    t(
      'erp_purchase_orders',
      ['id'],
      [['id', 'VARCHAR'], ['supplier_id', 'VARCHAR'], ['sku', 'VARCHAR'], ['qty', 'DOUBLE'], ['unit_price', 'DOUBLE'], ['eta', 'DATE'], ['original_eta', 'DATE'], ['status', 'VARCHAR'], ['express', 'BOOLEAN'], ['note', 'VARCHAR']],
      w.purchaseOrders.map((p) => ({ id: p.id, supplier_id: p.supplierId, sku: p.sku, qty: p.qty, unit_price: p.unitPrice, eta: p.eta, original_eta: p.originalEta, status: p.status, express: p.express, note: p.note })),
    ),
    t(
      'erp_production_orders',
      ['id'],
      [['id', 'VARCHAR'], ['sales_order_id', 'VARCHAR'], ['factory_id', 'VARCHAR'], ['product', 'VARCHAR'], ['fabric', 'VARCHAR'], ['qty', 'BIGINT'], ['priority', 'BIGINT'], ['due_date', 'DATE'], ['status', 'VARCHAR']],
      w.productionOrders.map((p) => ({ id: p.id, sales_order_id: p.salesOrderId, factory_id: p.factory, product: p.product, fabric: p.fabric, qty: p.qty, priority: p.priority, due_date: p.dueDate, status: p.status })),
    ),
    t(
      'erp_maintenance_tickets',
      ['id'],
      [['id', 'VARCHAR'], ['machine_id', 'VARCHAR'], ['status', 'VARCHAR'], ['required_part', 'VARCHAR'], ['details', 'JSON']],
      w.tickets.map(({ id, machineId, status, requiredPart, ...rest }) => ({ id, machine_id: machineId, status, required_part: requiredPart ?? null, details: JSON.stringify(rest) })),
    ),
    t(
      'crm_customers',
      ['id'],
      [['id', 'VARCHAR'], ['name', 'VARCHAR'], ['tier', 'VARCHAR'], ['penalty_pct_per_week_late', 'DOUBLE'], ['contact', 'VARCHAR']],
      w.customers.map((c) => ({ id: c.id, name: c.name, tier: c.tier, penalty_pct_per_week_late: c.penaltyPctPerWeekLate, contact: c.contact })),
    ),
    t(
      'crm_orders',
      ['id'],
      [['id', 'VARCHAR'], ['customer_id', 'VARCHAR'], ['product', 'VARCHAR'], ['qty', 'BIGINT'], ['fabric', 'VARCHAR'], ['promised_delivery', 'DATE'], ['communicated_delivery', 'DATE'], ['status', 'VARCHAR']],
      w.salesOrders.map((s) => ({ id: s.id, customer_id: s.customerId, product: s.product, qty: s.qty, fabric: s.fabric, promised_delivery: s.promisedDelivery, communicated_delivery: s.communicatedDelivery, status: s.status })),
    ),
    t(
      'crm_campaigns',
      ['id'],
      [['id', 'VARCHAR'], ['name', 'VARCHAR'], ['date_from', 'DATE'], ['date_to', 'DATE'], ['status', 'VARCHAR'], ['daily_budget_pct', 'DOUBLE'], ['note', 'VARCHAR']],
      w.campaigns.map((c) => ({ id: c.id, name: c.name, date_from: c.from, date_to: c.to, status: c.status, daily_budget_pct: c.dailyBudgetPct, note: c.note })),
    ),
    // Demand plan: the order intake the production plan is based on (get_demand_trend compares intake with it).
    t(
      'crm_demand',
      ['sales_order_id'],
      [['sales_order_id', 'VARCHAR'], ['customer_id', 'VARCHAR'], ['product', 'VARCHAR'], ['qty', 'BIGINT'], ['promised_delivery', 'DATE'], ['source', 'VARCHAR']],
      SALES.map(([id, customerId, product, qty, , promised]) => ({ sales_order_id: id, customer_id: customerId, product, qty, promised_delivery: promised, source: 'plan' })),
    ),
  ];
}

/** Rows per table, the yardstick for "the raw zone holds the same entities as the mock" (M1 exit criterion). */
export const extractCounts = (tables: RawTable[]) => Object.fromEntries(tables.map((x) => [x.name, x.rows.length]));
