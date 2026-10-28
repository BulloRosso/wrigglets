// Mock company systems for the sofa-company example (docs/agentic-mitigations.md). NO AUTHENTICATION, no dependencies.
// One stateful, deterministic simulation of a sofa maker, served as two MCP servers:
//
//   POST /erp/mcp   ERP: factories, machines, workers, production orders, warehouse, purchasing
//   POST /crm/mcp   CRM: customers, sales orders, campaigns, customer notices
//
// The world has a fixed clock (TODAY). Production is simulated day by day from the current state: capacity of the
// factories, the order queues, material stock and purchase-order arrivals. Everything an agent reads (completion
// dates, late orders, stock-out dates) is derived from that state, and every write tool changes the state, so a
// mitigation either works in the simulation or it does not.
//
//   POST /scenario/<id>/start   inject a disruption (supplier-beams | machine-failure | demand-spike | sick-leave | storm)
//   POST /reset                 back to the undisturbed baseline
//   GET  /kpi                   business impact now (late orders, shortages, cost of measures)
//   GET  /log                   every write an agent made     GET /notices  customer notices "sent"     GET /health
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 7660);
const TODAY = '2026-10-05'; // a Monday
const HORIZON_WORKDAYS = 70;
const SHIPPING_DAYS = 3; // calendar days from end of production to the customer

/* ------------------------------------------------------------------ dates */

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 86_400_000));
const diffDays = (a, b) => Math.round((D(a).getTime() - D(b).getTime()) / 86_400_000);
const isWork = (s) => ![0, 6].includes(D(s).getUTCDay());
const nextWork = (s) => {
  while (!isWork(s)) s = addDays(s, 1);
  return s;
};
const addWork = (s, n) => {
  for (let c = 0; c < n; ) {
    s = addDays(s, 1);
    if (isWork(s)) c++;
  }
  return s;
};
const FAR = '9999-12-31';

/* ------------------------------------------------------------------ world */

const PRODUCTS = {
  LUND: { name: 'Lund 2-seater', beams: 6, fabricM: 6, foam: 2 },
  OSLO: { name: 'Oslo 3-seater', beams: 8, fabricM: 8, foam: 3 },
  BERGEN: { name: 'Bergen corner sofa', beams: 12, fabricM: 13, foam: 4 },
};
const SKU = {
  'BEAM-PINE-80': { name: 'Pine beam 80 mm (frame)', unit: 'pcs', cost: 4.2 },
  'FAB-OAT-01': { name: 'Upholstery fabric Oatmeal', unit: 'm', cost: 11.8 },
  'FAB-ANTH-02': { name: 'Upholstery fabric Anthracite', unit: 'm', cost: 11.8 },
  'FOAM-HR35': { name: 'HR35 foam block', unit: 'pcs', cost: 9.5 },
  'SP-SPINDLE-220': { name: 'Spare part: CNC spindle motor 220', unit: 'pcs', cost: 6800 },
};

// Quantities are tuned so the baseline plan is on time with slack (see /kpi after /reset).
const SALES = [
  ['SO-2101', 'C-01', 'OSLO', 100, 'FAB-OAT-01', '2026-10-14'],
  ['SO-2102', 'C-02', 'LUND', 120, 'FAB-ANTH-02', '2026-10-16'],
  ['SO-2103', 'C-03', 'BERGEN', 60, 'FAB-OAT-01', '2026-10-16'],
  ['SO-2104', 'C-04', 'LUND', 150, 'FAB-OAT-01', '2026-10-21'],
  ['SO-2105', 'C-01', 'OSLO', 110, 'FAB-ANTH-02', '2026-10-23'],
  ['SO-2106', 'C-05', 'BERGEN', 70, 'FAB-ANTH-02', '2026-10-23'],
  ['SO-2107', 'C-02', 'OSLO', 120, 'FAB-OAT-01', '2026-10-28'],
  ['SO-2108', 'C-06', 'LUND', 140, 'FAB-OAT-01', '2026-10-30'],
  ['SO-2109', 'C-03', 'OSLO', 90, 'FAB-ANTH-02', '2026-11-03'],
  ['SO-2110', 'C-04', 'BERGEN', 70, 'FAB-OAT-01', '2026-11-04'],
  ['SO-2111', 'C-05', 'LUND', 130, 'FAB-ANTH-02', '2026-11-06'],
  ['SO-2112', 'C-01', 'OSLO', 110, 'FAB-OAT-01', '2026-11-10'],
  ['SO-2113', 'C-06', 'BERGEN', 60, 'FAB-OAT-01', '2026-11-12'],
  ['SO-2114', 'C-02', 'LUND', 120, 'FAB-ANTH-02', '2026-11-13'],
  ['SO-2115', 'C-03', 'OSLO', 100, 'FAB-OAT-01', '2026-11-17'],
  ['SO-2116', 'C-04', 'LUND', 110, 'FAB-OAT-01', '2026-11-18'],
  ['SO-2117', 'C-05', 'OSLO', 90, 'FAB-ANTH-02', '2026-11-20'],
  ['SO-2118', 'C-06', 'BERGEN', 50, 'FAB-ANTH-02', '2026-11-24'],
];
// Orders caused by the autumn campaign (injected by the demand-spike scenario)
const CAMPAIGN_SALES = [
  ['SO-2301', 'C-06', 'LUND', 130, 'FAB-OAT-01', '2026-10-26'],
  ['SO-2302', 'C-06', 'OSLO', 100, 'FAB-ANTH-02', '2026-10-29'],
  ['SO-2303', 'C-04', 'LUND', 150, 'FAB-OAT-01', '2026-11-04'],
  ['SO-2304', 'C-02', 'OSLO', 110, 'FAB-OAT-01', '2026-11-09'],
  ['SO-2305', 'C-05', 'LUND', 130, 'FAB-ANTH-02', '2026-11-12'],
  ['SO-2306', 'C-06', 'LUND', 170, 'FAB-OAT-01', '2026-11-16'],
  ['SO-2307', 'C-03', 'OSLO', 120, 'FAB-ANTH-02', '2026-11-19'],
  ['SO-2308', 'C-06', 'BERGEN', 60, 'FAB-OAT-01', '2026-11-24'],
];

let W;
let seq;

function salesOrder([id, customerId, product, qty, fabric, promised], extra = {}) {
  return { id, customerId, product, qty, fabric, promisedDelivery: promised, communicatedDelivery: null, status: 'confirmed', ...extra };
}

function freshWorld() {
  seq = { po: 4430, ticket: 1, inc: 1, prd: 4200 };
  const w = {
    factories: {
      'F-NORTH': { id: 'F-NORTH', name: 'Werk Nord (Hamburg)' },
      'F-SOUTH': { id: 'F-SOUTH', name: 'Werk Süd (Stuttgart)' },
    },
    machines: ['N', 'S'].flatMap((p) =>
      [
        ['CUT-1', 'CNC frame cutter', 60],
        ['UPH-1', 'Upholstery line', 50],
        ['ASM-1', 'Assembly line', 48],
      ].map(([n, name, rate]) => ({ id: `${p}-${n}`, factory: p === 'N' ? 'F-NORTH' : 'F-SOUTH', name, ratePerDay: rate, status: 'running', downSince: null, note: '' })),
    ),
    workers: [
      { id: 'W-N1', name: 'Kai Brandt', factory: 'F-NORTH', absences: [] },
      { id: 'W-N2', name: 'Mira Sommer', factory: 'F-NORTH', absences: [] },
      { id: 'W-S1', name: 'Lena Hartmann', factory: 'F-SOUTH', absences: [] },
      { id: 'W-S2', name: 'Tobias Klein', factory: 'F-SOUTH', absences: [] },
    ],
    temp: [],
    overtime: [],
    suppliers: [
      { id: 'S-NORDHOLZ', name: 'Nordholz Sägewerk GmbH', skus: ['BEAM-PINE-80'], leadWorkdays: 8, unitPrice: 4.2, minQty: 2000, maxQty: 20000, expressLeadWorkdays: null, expressSurchargePerUnit: 0, rating: 'A', status: 'ok', notice: null },
      { id: 'S-BALTIC', name: 'Baltic Timber OÜ (Tallinn)', skus: ['BEAM-PINE-80'], leadWorkdays: 6, unitPrice: 4.6, minQty: 1000, maxQty: 6000, expressLeadWorkdays: 4, expressSurchargePerUnit: 0.3, rating: 'A', status: 'ok', notice: null },
      { id: 'S-SILESIA', name: 'Silesia Wood sp. z o.o.', skus: ['BEAM-PINE-80'], leadWorkdays: 10, unitPrice: 4.35, minQty: 500, maxQty: 3000, expressLeadWorkdays: null, expressSurchargePerUnit: 0, rating: 'B', status: 'ok', notice: null },
      { id: 'S-TUCHWERK', name: 'Tuchwerk Bielefeld AG', skus: ['FAB-OAT-01', 'FAB-ANTH-02'], leadWorkdays: 12, unitPrice: 11.8, minQty: 1000, maxQty: 30000, expressLeadWorkdays: 8, expressSurchargePerUnit: 1.1, rating: 'A', status: 'ok', notice: null },
      { id: 'S-COMO', name: 'Tessile Como S.p.A.', skus: ['FAB-OAT-01'], leadWorkdays: 8, unitPrice: 13.2, minQty: 500, maxQty: 8000, expressLeadWorkdays: null, expressSurchargePerUnit: 0, rating: 'B', status: 'ok', notice: null },
      { id: 'S-FOAMTEC', name: 'FoamTec GmbH', skus: ['FOAM-HR35'], leadWorkdays: 5, unitPrice: 9.5, minQty: 500, maxQty: 20000, expressLeadWorkdays: null, expressSurchargePerUnit: 0, rating: 'A', status: 'ok', notice: null },
      { id: 'S-REITER', name: 'Maschinenbau Reiter KG', skus: ['SP-SPINDLE-220'], leadWorkdays: 9, unitPrice: 6800, minQty: 1, maxQty: 2, expressLeadWorkdays: 4, expressSurchargePerUnit: 2400, rating: 'A', status: 'ok', notice: null },
    ],
    lots: [
      { id: 'L-BEAM-1001', sku: 'BEAM-PINE-80', qty: 5200, location: 'WH-1 / rack A', status: 'ok', note: '' },
      { id: 'L-OAT-231', sku: 'FAB-OAT-01', qty: 9000, location: 'WH-1 / hall 2 west', status: 'ok', note: '' },
      { id: 'L-OAT-228', sku: 'FAB-OAT-01', qty: 6000, location: 'WH-1 / hall 1', status: 'ok', note: '' },
      { id: 'L-ANTH-219', sku: 'FAB-ANTH-02', qty: 8500, location: 'WH-1 / hall 1', status: 'ok', note: '' },
      { id: 'L-FOAM-077', sku: 'FOAM-HR35', qty: 6000, location: 'WH-1 / hall 3', status: 'ok', note: '' },
    ],
    purchaseOrders: [
      { id: 'PO-4411', supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', qty: 8000, unitPrice: 4.2, eta: '2026-10-12', originalEta: '2026-10-12', status: 'open', express: false, note: '' },
      { id: 'PO-4418', supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', qty: 7000, unitPrice: 4.2, eta: '2026-11-02', originalEta: '2026-11-02', status: 'open', express: false, note: '' },
      { id: 'PO-4420', supplierId: 'S-TUCHWERK', sku: 'FAB-OAT-01', qty: 6000, unitPrice: 11.8, eta: '2026-11-02', originalEta: '2026-11-02', status: 'open', express: false, note: '' },
      { id: 'PO-4421', supplierId: 'S-TUCHWERK', sku: 'FAB-ANTH-02', qty: 4000, unitPrice: 11.8, eta: '2026-10-26', originalEta: '2026-10-26', status: 'open', express: false, note: '' },
    ],
    customers: [
      { id: 'C-01', name: 'Möbel Krüger', tier: 'A', penaltyPctPerWeekLate: 2, contact: 'einkauf@krueger-moebel.example' },
      { id: 'C-02', name: 'Wohnwelt24', tier: 'A', penaltyPctPerWeekLate: 2, contact: 'orders@wohnwelt24.example' },
      { id: 'C-03', name: 'Nordic Living GmbH', tier: 'B', penaltyPctPerWeekLate: 1, contact: 'procurement@nordic-living.example' },
      { id: 'C-04', name: 'Heim & Haus Kette', tier: 'A', penaltyPctPerWeekLate: 3, contact: 'wareneingang@heimhaus.example' },
      { id: 'C-05', name: 'Casa Moderna', tier: 'B', penaltyPctPerWeekLate: 0, contact: 'ordini@casamoderna.example' },
      { id: 'C-06', name: 'Interio Online', tier: 'B', penaltyPctPerWeekLate: 1, contact: 'supply@interio-online.example' },
    ],
    salesOrders: SALES.map((r) => salesOrder(r)),
    productionOrders: [],
    tickets: [],
    campaigns: [{ id: 'CMP-HERBST', name: 'Herbstzauber (autumn sale, online ads)', from: '2026-10-01', to: '2026-10-31', status: 'active', dailyBudgetPct: 100, note: '' }],
    incidents: [],
    customerNotices: [],
    log: [],
    costEur: 0,
    events: [],
  };
  // one production order per sales order; alternate factories, lowest priority number = most urgent
  w.productionOrders = w.salesOrders.map((s, i) => prod(s, i % 2 === 0 ? 'F-NORTH' : 'F-SOUTH'));
  return w;
}

function prod(s, factory) {
  return { id: `PRD-${seq.prd++}`, salesOrderId: s.id, factory, product: s.product, fabric: s.fabric, qty: s.qty, priority: 5, dueDate: addDays(s.promisedDelivery, -SHIPPING_DAYS), status: 'planned' };
}

/* ------------------------------------------------------------------ capacity and simulation */

function downUntil(m) {
  if (m.status !== 'down') return null;
  const t = W.tickets.find((x) => x.machineId === m.id && x.status === 'open');
  const part = t && W.purchaseOrders.find((p) => p.sku === t.requiredPart && p.status === 'open');
  return part ? addWork(part.eta, 2) : FAR; // repair takes 2 workdays after the spare part has arrived
}
const machineDownOn = (m, d) => m.status === 'down' && d >= m.downSince && d <= downUntil(m);

function capacity(f, d) {
  if (!isWork(d)) return { cap: 0, reason: 'non-working day' };
  const down = W.machines.filter((m) => m.factory === f && machineDownOn(m, d));
  if (down.length) return { cap: 0, reason: `machine down: ${down.map((m) => m.id).join(', ')}` };
  const staff = W.workers.filter((x) => x.factory === f);
  const present = staff.filter((x) => !x.absences.some((a) => a.from <= d && d <= a.to)).length;
  const temps = W.temp.filter((t) => t.factory === f && t.from <= d && d <= t.to).reduce((s, t) => s + t.count, 0);
  let base = present * 20 + temps * 15;
  const ot = W.overtime.some((o) => o.factory === f && o.from <= d && d <= o.to);
  if (ot && base > 0) base = Math.round(base * 1.25);
  const cap = Math.min(48, base);
  const why = [`${present}/${staff.length} regular workers`];
  if (temps) why.push(`${temps} temp worker(s)`);
  if (ot) why.push('overtime');
  return { cap, reason: why.join(', ') };
}

const usable = (sku) => W.lots.filter((l) => l.sku === sku && l.status === 'ok').reduce((s, l) => s + l.qty, 0);

let simCache;
function simulate() {
  if (simCache) return simCache;
  const stock = Object.fromEntries(Object.keys(SKU).map((k) => [k, usable(k)]));
  const inbound = W.purchaseOrders.filter((p) => p.status === 'open' || p.status === 'delayed');
  const produced = Object.fromEntries(W.productionOrders.map((p) => [p.id, 0]));
  const done = {};
  const blocked = {}; // order id -> { sku, firstDate }
  const shortage = {}; // sku -> first workday on which production was held back by it
  const days = [];
  let d = nextWork(TODAY);
  for (let i = 0; i < HORIZON_WORKDAYS; i++, d = addWork(d, 1)) {
    for (const p of inbound) if (nextWork(p.eta) === d) stock[p.sku] += p.qty;
    const row = { date: d, produced: { 'F-NORTH': 0, 'F-SOUTH': 0 }, stock: { ...stock } };
    for (const f of Object.keys(W.factories)) {
      let cap = capacity(f, d).cap;
      const queue = W.productionOrders.filter((p) => p.factory === f && produced[p.id] < p.qty).sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
      for (const o of queue) {
        if (cap <= 0) break;
        const bom = PRODUCTS[o.product];
        const limits = { 'BEAM-PINE-80': Math.floor(stock['BEAM-PINE-80'] / bom.beams), [o.fabric]: Math.floor(stock[o.fabric] / bom.fabricM), 'FOAM-HR35': Math.floor(stock['FOAM-HR35'] / bom.foam) };
        const want = Math.min(cap, o.qty - produced[o.id]);
        const [limSku, lim] = Object.entries(limits).sort((a, b) => a[1] - b[1])[0];
        const n = Math.min(want, lim);
        if (n < want) {
          blocked[o.id] ??= { sku: limSku, firstDate: d };
          shortage[limSku] ??= d;
        }
        if (n <= 0) continue;
        stock['BEAM-PINE-80'] -= n * bom.beams;
        stock[o.fabric] -= n * bom.fabricM;
        stock['FOAM-HR35'] -= n * bom.foam;
        produced[o.id] += n;
        cap -= n;
        row.produced[f] += n;
        if (produced[o.id] >= o.qty) done[o.id] = d;
      }
    }
    row.stockEnd = { ...stock };
    days.push(row);
  }
  simCache = { done, blocked, shortage, days };
  return simCache;
}
const touch = () => (simCache = undefined);

function orderView(po) {
  const sim = simulate();
  const so = W.salesOrders.find((s) => s.id === po.salesOrderId);
  const end = sim.done[po.id] ?? null;
  const expected = end ? addDays(end, SHIPPING_DAYS) : null;
  return { so, end, expected, late: expected ? Math.max(0, diffDays(expected, so.promisedDelivery)) : null, blocked: sim.blocked[po.id] };
}

function kpi() {
  const sim = simulate();
  const rows = W.salesOrders.map((so) => {
    const po = W.productionOrders.find((p) => p.salesOrderId === so.id);
    if (!po) return { so, planned: false };
    const v = orderView(po);
    return { so, planned: true, expected: v.expected, late: v.late ?? 999 };
  });
  const late = rows.filter((r) => r.planned && r.late > 0);
  const unplanned = rows.filter((r) => !r.planned);
  const sofasLate = late.reduce((s, r) => s + r.so.qty, 0);
  return {
    simulationDate: TODAY,
    salesOrders: rows.length,
    plannedOrders: rows.length - unplanned.length,
    unplannedOrders: unplanned.map((r) => r.so.id),
    lateOrders: late.length,
    lateOrdersCustomerNotInformed: late.filter((r) => !r.so.communicatedDelivery).length,
    sofasLate,
    totalLateDays: late.reduce((s, r) => s + Math.min(r.late, 60), 0),
    materialShortages: Object.fromEntries(Object.entries(sim.shortage).map(([k, v]) => [k, `production held back from ${v}`])),
    costOfMeasuresEur: Math.round(W.costEur),
    writes: W.log.length,
  };
}

/* ------------------------------------------------------------------ scenarios */

const SCENARIOS = {
  'supplier-beams': () => {
    const s = W.suppliers.find((x) => x.id === 'S-NORDHOLZ');
    s.status = 'cannot_deliver';
    s.notice = 'Sawmill Nordholz, 2026-10-05: storm damage to our drying kilns. We cannot deliver pine beams before 2026-11-30. PO-4411 and PO-4418 are postponed. Sorry.';
    for (const p of W.purchaseOrders.filter((x) => x.supplierId === 'S-NORDHOLZ')) {
      p.status = 'delayed';
      p.eta = p.id === 'PO-4411' ? '2026-11-30' : '2026-12-14';
      p.note = 'Postponed by the supplier (kiln damage)';
    }
  },
  'machine-failure': () => {
    const m = W.machines.find((x) => x.id === 'N-CUT-1');
    m.status = 'down';
    m.downSince = TODAY;
    m.note = 'Drive error E-4410 on the spindle. Diagnosis by the shift lead: spindle motor SP-SPINDLE-220 is defective and must be replaced; no spare in the warehouse.';
  },
  'demand-spike': () => {
    for (const r of CAMPAIGN_SALES) W.salesOrders.push(salesOrder(r, { status: 'confirmed_unplanned', source: 'campaign CMP-HERBST' }));
    W.campaigns[0].note = 'Order intake since 2026-10-01 is 42% above plan; the campaign runs until 2026-10-31.';
  },
  'sick-leave': () => {
    for (const w of W.workers.filter((x) => x.factory === 'F-SOUTH')) w.absences.push({ from: '2026-10-12', to: '2026-10-23', reason: 'sick leave (certificate received)' });
  },
  storm: () => {
    const hit = { 'L-OAT-231': '7,200 m water-damaged (mould risk, not usable); 1,800 m dry and usable', 'L-ANTH-219': '6,800 m water-damaged (mould risk, not usable); 1,700 m dry and usable' };
    for (const [id, verdict] of Object.entries(hit)) {
      const l = W.lots.find((x) => x.id === id);
      l.status = 'quarantined';
      l.note = `Storm 2026-10-04: roof leak in the fabric hall. Surveyor report 2026-10-05: ${verdict}. Disposition pending.`;
    }
  },
};

/* ------------------------------------------------------------------ tools */

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 1) }], ...(isError ? { isError: true } : {}) });
const err = (m) => text(m, true);
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description) => ({ type: 'number', description });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });

function record(tool, args, result) {
  W.log.push({ at: new Date().toISOString(), tool, args, result });
  touch();
}

const fOf = (id) => W.factories[id];
const factoryArg = str('Factory id: F-NORTH or F-SOUTH', { enum: Object.keys({ 'F-NORTH': 1, 'F-SOUTH': 1 }) });

const ERP = [
  {
    name: 'get_overview',
    description: 'ERP dashboard as of the simulation date: factories (capacity, machines, staff), alerts from the shop floor and warehouse, and business KPIs (late orders, material shortages). Start here.',
    inputSchema: obj(),
    run: () => {
      const alerts = [];
      for (const m of W.machines.filter((x) => x.status === 'down')) alerts.push({ type: 'machine_down', machine: m.id, factory: m.factory, since: m.downSince, note: m.note, maintenanceTicket: W.tickets.find((t) => t.machineId === m.id && t.status === 'open')?.id ?? 'none yet', backInService: downUntil(m) === FAR ? 'unknown (no repair scheduled)' : downUntil(m) });
      for (const w of W.workers) for (const a of w.absences) alerts.push({ type: 'absence', worker: w.name, factory: w.factory, from: a.from, to: a.to, reason: a.reason });
      for (const s of W.suppliers.filter((x) => x.status !== 'ok')) alerts.push({ type: 'supplier', supplier: s.id, status: s.status, notice: s.notice });
      for (const l of W.lots.filter((x) => x.status === 'quarantined')) alerts.push({ type: 'stock_quarantined', lot: l.id, sku: l.sku, qty: l.qty, note: l.note });
      const unplanned = W.salesOrders.filter((s) => !W.productionOrders.some((p) => p.salesOrderId === s.id));
      if (unplanned.length) alerts.push({ type: 'unplanned_sales_orders', count: unplanned.length, sofas: unplanned.reduce((a, s) => a + s.qty, 0), orders: unplanned.map((s) => s.id) });
      const next = [];
      for (let d = nextWork(TODAY); next.length < 10; d = addWork(d, 1)) next.push(d);
      const fac = Object.keys(W.factories).map((f) => ({ id: f, name: fOf(f).name, machines: W.machines.filter((m) => m.factory === f).map((m) => `${m.id} ${m.status}`), sofasPerDayNext10Workdays: next.map((d) => capacity(f, d).cap) }));
      return text({ simulationDate: TODAY, factories: fac, alerts, kpi: kpi() });
    },
  },
  {
    name: 'get_kpi',
    description: 'Business KPI of the plan right now: orders expected late, sofas late, unplanned orders, orders late without customer notice, material shortages, cost of measures. This is the measure of success.',
    inputSchema: obj(),
    run: () => text(kpi()),
  },
  {
    name: 'simulate_change',
    description:
      'WHAT-IF, read-only. Applies one change, or a SEQUENCE of changes (parameter "changes", applied in order), of the ERP change tools (create_purchase_order, update_production_order, create_production_order, request_overtime, request_temp_workers, write_off_stock, release_stock ...) to a COPY of the company state and returns what each would answer plus the KPI before and after. Nothing is changed. Single options often are not enough: test COMBINATIONS (for example two purchase orders plus overtime) and compare them. Apply the chosen changes only in the execute step.',
    inputSchema: obj(
      {
        tool: str('Name of an ERP change tool (single change)'),
        arguments: { type: 'object', description: 'Arguments of that tool (single change)' },
        changes: { type: 'array', description: 'A sequence of changes to apply together', items: { type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['tool', 'arguments'] } },
      },
      [],
    ),
    run: (a) => {
      const list = Array.isArray(a.changes) && a.changes.length ? a.changes : a.tool ? [{ tool: a.tool, arguments: a.arguments ?? {} }] : [];
      if (!list.length) return err('Give "tool" and "arguments", or a list "changes".');
      const writes = ERP.filter((x) => x.write);
      const unknown = list.find((c) => !writes.some((x) => x.name === c.tool));
      if (unknown) return err(`Unknown change tool ${unknown.tool}. Known: ${writes.map((x) => x.name).join(', ')}`);
      const pick = (k) => ({ lateOrders: k.lateOrders, sofasLate: k.sofasLate, unplannedOrders: k.unplannedOrders.length, lateWithoutCustomerNotice: k.lateOrdersCustomerNotInformed, materialShortages: k.materialShortages, costOfMeasuresEur: k.costOfMeasuresEur });
      const before = pick(kpi());
      const saved = { w: W, seq };
      W = structuredClone(W);
      seq = { ...seq };
      touch();
      try {
        const results = list.slice(0, 12).map((c) => {
          const out = writes.find((x) => x.name === c.tool).run(c.arguments ?? {});
          return { tool: c.tool, wouldSucceed: !out.isError, answer: out.content[0].text.slice(0, 300) };
        });
        return text({ results, kpiBefore: before, kpiAfter: pick(kpi()), note: 'Simulation only: nothing was changed.' });
      } finally {
        W = saved.w;
        seq = saved.seq;
        touch();
      }
    },
  },
  {
    name: 'list_machines',
    description: 'Machines per factory with status, notes and the open maintenance ticket.',
    inputSchema: obj({ factory: factoryArg }),
    run: (a) => text(W.machines.filter((m) => !a.factory || m.factory === a.factory).map((m) => ({ ...m, ticket: W.tickets.find((t) => t.machineId === m.id && t.status === 'open') ?? null, backInService: m.status === 'down' ? (downUntil(m) === FAR ? 'unknown' : downUntil(m)) : null }))),
  },
  {
    name: 'list_workers',
    description: 'Production workers per factory with planned absences.',
    inputSchema: obj({ factory: factoryArg }),
    run: (a) => text({ workers: W.workers.filter((w) => !a.factory || w.factory === a.factory), temporaryWorkers: W.temp, overtime: W.overtime, rule: 'A regular worker delivers 20 sofas/day, a temporary worker 15; a factory tops out at 48 sofas/day; overtime adds 25%.' }),
  },
  {
    name: 'get_capacity',
    description: 'Daily production capacity (sofas/day) of a factory for the next workdays, with the reason.',
    inputSchema: obj({ factory: factoryArg, days: num('Number of workdays, default 15') }, ['factory']),
    run: (a) => {
      if (!W.factories[a.factory]) return err(`Unknown factory ${a.factory}`);
      const rows = [];
      for (let d = nextWork(TODAY); rows.length < Math.min(Number(a.days ?? 15), 60); d = addWork(d, 1)) rows.push({ date: d, ...capacity(a.factory, d) });
      return text({ factory: a.factory, rows });
    },
  },
  {
    name: 'list_production_orders',
    description: 'Production orders with factory, priority, quantity, due date and the simulated completion date. Filter by factory or show only orders that will miss their delivery promise.',
    inputSchema: obj({ factory: factoryArg, lateOnly: { type: 'boolean', description: 'Only orders expected to deliver after the promised date' } }),
    run: (a) =>
      text(
        W.productionOrders
          .filter((p) => !a.factory || p.factory === a.factory)
          .map((p) => ({ p, v: orderView(p) }))
          .filter(({ v }) => !a.lateOnly || v.late === null || v.late > 0)
          .map(({ p, v }) => ({ id: p.id, salesOrder: p.salesOrderId, factory: p.factory, product: p.product, fabric: p.fabric, qty: p.qty, priority: p.priority, productionDue: p.dueDate, completion: v.end ?? 'not within 70 workdays', expectedDelivery: v.expected, promisedDelivery: v.so.promisedDelivery, daysLate: v.late, heldBackBy: v.blocked ? `${v.blocked.sku} from ${v.blocked.firstDate}` : null })),
      ),
  },
  {
    name: 'get_inventory',
    description: 'Warehouse stock by lot (status ok, quarantined or written_off) with the total usable quantity per SKU.',
    inputSchema: obj({ sku: str('Optional SKU filter, e.g. BEAM-PINE-80') }),
    run: (a) => {
      const lots = W.lots.filter((l) => !a.sku || l.sku === a.sku);
      const skus = [...new Set(lots.map((l) => l.sku))];
      return text({ skus: skus.map((k) => ({ sku: k, name: SKU[k]?.name, unit: SKU[k]?.unit, usable: usable(k), totalOnHand: lots.filter((l) => l.sku === k).reduce((s, l) => s + l.qty, 0) })), lots });
    },
  },
  {
    name: 'get_material_projection',
    description: 'Projected stock of a SKU over the coming workdays (consumption by the production plan, arrival of open purchase orders) and the first day production is held back by a shortage.',
    inputSchema: obj({ sku: str('SKU, e.g. BEAM-PINE-80 or FAB-OAT-01') }, ['sku']),
    run: (a) => {
      if (!SKU[a.sku]) return err(`Unknown SKU ${a.sku}. Known: ${Object.keys(SKU).join(', ')}`);
      const sim = simulate();
      return text({
        sku: a.sku,
        usableNow: usable(a.sku),
        openPurchaseOrders: W.purchaseOrders.filter((p) => p.sku === a.sku && p.status !== 'cancelled').map((p) => ({ id: p.id, qty: p.qty, eta: p.eta, status: p.status })),
        firstShortage: sim.shortage[a.sku] ? `production is held back from ${sim.shortage[a.sku]}` : 'no shortage within 70 workdays',
        weeklyEndOfWeekStock: sim.days.filter((r) => D(r.date).getUTCDay() === 5).slice(0, 8).map((r) => ({ week_ending: r.date, stock: r.stockEnd[a.sku] })),
      });
    },
  },
  {
    name: 'list_purchase_orders',
    description: 'Purchase orders with supplier, quantity, delivery date and status (open, delayed, cancelled).',
    inputSchema: obj({ sku: str('Optional SKU filter') }),
    run: (a) => text(W.purchaseOrders.filter((p) => !a.sku || p.sku === a.sku)),
  },
  {
    name: 'list_suppliers',
    description: 'Suppliers with the SKUs they supply, lead time, price, order size limits, express option and current status/notice.',
    inputSchema: obj({ sku: str('Optional SKU filter') }),
    run: (a) => text(W.suppliers.filter((s) => !a.sku || s.skus.includes(a.sku))),
  },
  {
    name: 'get_bom',
    description: 'Bill of materials of a sofa model (beams, fabric metres, foam blocks per sofa).',
    inputSchema: obj({ product: str('LUND, OSLO or BERGEN') }),
    run: (a) => text(a.product ? (PRODUCTS[String(a.product).toUpperCase()] ?? `Unknown product ${a.product}`) : PRODUCTS),
  },
  {
    name: 'list_maintenance_tickets',
    description: 'Maintenance tickets with status and planned repair date.',
    inputSchema: obj(),
    run: () => text(W.tickets),
  },
  /* ---- writes ---- */
  {
    name: 'create_purchase_order',
    description: 'WRITE. Place a purchase order with a supplier. Returns the delivery date. Fails if the supplier cannot deliver or the quantity is outside its limits.',
    write: true,
    inputSchema: obj({ supplierId: str('Supplier id, e.g. S-BALTIC'), sku: str('SKU'), quantity: num('Quantity'), express: { type: 'boolean', description: 'Express delivery if the supplier offers it (surcharge per unit)' }, note: str('Reason / reference') }, ['supplierId', 'sku', 'quantity']),
    run: (a) => {
      const s = W.suppliers.find((x) => x.id === a.supplierId);
      if (!s) return err(`Unknown supplier ${a.supplierId}`);
      if (s.status !== 'ok') return err(`Supplier ${s.id} cannot deliver at the moment: ${s.notice}`);
      if (!s.skus.includes(a.sku)) return err(`${s.id} does not supply ${a.sku}`);
      const q = Number(a.quantity);
      if (!(q >= s.minQty && q <= s.maxQty)) return err(`Quantity must be between ${s.minQty} and ${s.maxQty} for ${s.id}`);
      if (a.express && s.expressLeadWorkdays == null) return err(`${s.id} offers no express delivery`);
      const lead = a.express ? s.expressLeadWorkdays : s.leadWorkdays;
      const unit = s.unitPrice + (a.express ? s.expressSurchargePerUnit : 0);
      const po = { id: `PO-${seq.po++}`, supplierId: s.id, sku: a.sku, qty: q, unitPrice: unit, eta: addWork(TODAY, lead), originalEta: addWork(TODAY, lead), status: 'open', express: !!a.express, note: a.note ?? '' };
      W.purchaseOrders.push(po);
      W.costEur += q * unit;
      record('erp.create_purchase_order', a, po.id);
      return text({ ...po, totalEur: Math.round(q * unit) });
    },
  },
  {
    name: 'cancel_purchase_order',
    description: 'WRITE. Cancel an open or delayed purchase order.',
    write: true,
    inputSchema: obj({ poId: str('Purchase order id'), reason: str('Reason') }, ['poId', 'reason']),
    run: (a) => {
      const p = W.purchaseOrders.find((x) => x.id === a.poId);
      if (!p) return err(`Unknown purchase order ${a.poId}`);
      p.status = 'cancelled';
      p.note = a.reason;
      record('erp.cancel_purchase_order', a, p.id);
      return text(p);
    },
  },
  {
    name: 'create_maintenance_ticket',
    description: 'WRITE. Open a maintenance ticket for a machine and book the external technician. The repair starts when the required spare part has been delivered (a purchase order for it must exist) and takes 2 workdays.',
    write: true,
    inputSchema: obj({ machineId: str('Machine id, e.g. N-CUT-1'), description: str('Fault description'), requiredPart: str('SKU of the spare part, if known') }, ['machineId', 'description']),
    run: (a) => {
      const m = W.machines.find((x) => x.id === a.machineId);
      if (!m) return err(`Unknown machine ${a.machineId}`);
      if (m.status !== 'down') return err(`${m.id} is running; no ticket needed`);
      if (W.tickets.some((t) => t.machineId === m.id && t.status === 'open')) return err(`There is already an open ticket for ${m.id}`);
      const t = { id: `MT-${String(seq.ticket++).padStart(3, '0')}`, machineId: m.id, description: a.description, requiredPart: a.requiredPart ?? 'SP-SPINDLE-220', status: 'open', technicianBooked: nextWork(addDays(TODAY, 1)), openedAt: TODAY };
      W.tickets.push(t);
      W.costEur += 450; // call-out fee
      record('erp.create_maintenance_ticket', a, t.id);
      return text({ ...t, hint: 'Repair can only start once the spare part is delivered. Place a purchase order for it if none exists.' });
    },
  },
  {
    name: 'update_production_order',
    description: 'WRITE. Move a production order to the other factory and/or change its priority (1 = most urgent … 9). The simulation re-sequences both factory queues.',
    write: true,
    inputSchema: obj({ orderId: str('Production order id, e.g. PRD-4204'), factory: factoryArg, priority: num('1-9') }, ['orderId']),
    run: (a) => {
      const p = W.productionOrders.find((x) => x.id === a.orderId);
      if (!p) return err(`Unknown production order ${a.orderId}`);
      if (a.factory) {
        if (!W.factories[a.factory]) return err(`Unknown factory ${a.factory}`);
        p.factory = a.factory;
      }
      if (a.priority != null) p.priority = Math.min(9, Math.max(1, Number(a.priority)));
      record('erp.update_production_order', a, p.id);
      return text({ ...p, completion: orderView(p).end, expectedDelivery: orderView(p).expected, daysLate: orderView(p).late });
    },
  },
  {
    name: 'create_production_order',
    description: 'WRITE. Create the production order for a confirmed, unplanned sales order and put it into a factory queue.',
    write: true,
    inputSchema: obj({ salesOrderId: str('Sales order id, e.g. SO-2301'), factory: factoryArg, priority: num('1-9, default 5') }, ['salesOrderId', 'factory']),
    run: (a) => {
      const s = W.salesOrders.find((x) => x.id === a.salesOrderId);
      if (!s) return err(`Unknown sales order ${a.salesOrderId}`);
      if (W.productionOrders.some((p) => p.salesOrderId === s.id)) return err(`${s.id} already has a production order`);
      if (!W.factories[a.factory]) return err(`Unknown factory ${a.factory}`);
      const p = prod(s, a.factory);
      if (a.priority != null) p.priority = Math.min(9, Math.max(1, Number(a.priority)));
      W.productionOrders.push(p);
      s.status = 'confirmed';
      record('erp.create_production_order', a, p.id);
      return text({ ...p, completion: orderView(p).end, expectedDelivery: orderView(p).expected, daysLate: orderView(p).late });
    },
  },
  {
    name: 'request_overtime',
    description: 'WRITE. Book overtime in a factory for a date range: +25% output of the available staff (max 48 sofas/day). Costs EUR 1,400 per factory and day.',
    write: true,
    inputSchema: obj({ factory: factoryArg, from: str('First day, YYYY-MM-DD'), to: str('Last day, YYYY-MM-DD') }, ['factory', 'from', 'to']),
    run: (a) => {
      if (!W.factories[a.factory]) return err(`Unknown factory ${a.factory}`);
      if (a.from < TODAY || a.to < a.from) return err('Invalid date range');
      let days = 0;
      for (let d = a.from; d <= a.to; d = addDays(d, 1)) if (isWork(d)) days++;
      W.overtime.push({ factory: a.factory, from: a.from, to: a.to });
      W.costEur += days * 1400;
      record('erp.request_overtime', a, `${days} days`);
      return text({ factory: a.factory, from: a.from, to: a.to, workdays: days, costEur: days * 1400 });
    },
  },
  {
    name: 'request_temp_workers',
    description: 'WRITE. Book temporary workers from the agency for a factory and date range. Each delivers 15 sofas/day. They start 3 workdays after the request. Costs EUR 260 per worker and day.',
    write: true,
    inputSchema: obj({ factory: factoryArg, count: num('Number of workers (1-4)'), from: str('First day, YYYY-MM-DD'), to: str('Last day, YYYY-MM-DD') }, ['factory', 'count', 'from', 'to']),
    run: (a) => {
      if (!W.factories[a.factory]) return err(`Unknown factory ${a.factory}`);
      const count = Math.round(Number(a.count));
      if (!(count >= 1 && count <= 4)) return err('count must be 1-4');
      const earliest = addWork(TODAY, 3);
      const from = a.from < earliest ? earliest : a.from;
      if (a.to < from) return err(`Agency can start on ${earliest} at the earliest`);
      let days = 0;
      for (let d = from; d <= a.to; d = addDays(d, 1)) if (isWork(d)) days++;
      W.temp.push({ factory: a.factory, count, from, to: a.to });
      W.costEur += days * count * 260;
      record('erp.request_temp_workers', a, `${count} x ${days} days`);
      return text({ factory: a.factory, count, from, to: a.to, workdays: days, costEur: days * count * 260, note: from !== a.from ? `Start moved to ${from} (agency lead time)` : undefined });
    },
  },
  {
    name: 'write_off_stock',
    description: 'WRITE. Write off a quantity of a warehouse lot (damaged goods). Cannot be undone.',
    write: true,
    inputSchema: obj({ lotId: str('Lot id, e.g. L-OAT-231'), quantity: num('Quantity to write off'), reason: str('Reason') }, ['lotId', 'quantity', 'reason']),
    run: (a) => {
      const l = W.lots.find((x) => x.id === a.lotId);
      if (!l) return err(`Unknown lot ${a.lotId}`);
      const q = Number(a.quantity);
      if (!(q > 0 && q <= l.qty)) return err(`Quantity must be between 1 and ${l.qty}`);
      l.qty -= q;
      const value = Math.round(q * (SKU[l.sku]?.cost ?? 0));
      W.writtenOffEur = (W.writtenOffEur ?? 0) + value;
      record('erp.write_off_stock', a, `${q} ${l.sku}`);
      return text({ lot: l.id, writtenOff: q, valueEur: value, remainingInLot: l.qty, status: l.status });
    },
  },
  {
    name: 'release_stock',
    description: 'WRITE. Release a quarantined lot (or part of it) for production after inspection.',
    write: true,
    inputSchema: obj({ lotId: str('Lot id'), quantity: num('Quantity to release'), note: str('Inspection reference') }, ['lotId', 'quantity']),
    run: (a) => {
      const l = W.lots.find((x) => x.id === a.lotId);
      if (!l) return err(`Unknown lot ${a.lotId}`);
      if (l.status !== 'quarantined') return err(`Lot ${l.id} is not quarantined`);
      const q = Number(a.quantity);
      if (!(q > 0 && q <= l.qty)) return err(`Quantity must be between 1 and ${l.qty}`);
      l.qty -= q;
      W.lots.push({ id: `${l.id}-R`, sku: l.sku, qty: q, location: l.location, status: 'ok', note: `Released after inspection. ${a.note ?? ''}`.trim() });
      record('erp.release_stock', a, `${q} ${l.sku}`);
      return text({ released: q, newLot: `${l.id}-R`, stillQuarantined: l.qty });
    },
  },
  {
    name: 'file_incident_report',
    description: 'WRITE. File an incident report for the insurance (storm, fire, theft …). Returns the claim number.',
    write: true,
    inputSchema: obj({ type: str('Incident type, e.g. storm_damage'), description: str('What happened'), estimatedLossEur: num('Estimated loss in EUR') }, ['type', 'description', 'estimatedLossEur']),
    run: (a) => {
      const i = { id: `INC-${String(seq.inc++).padStart(4, '0')}`, ...a, claim: 'prepared for the insurer', filedAt: TODAY };
      W.incidents.push(i);
      record('erp.file_incident_report', a, i.id);
      return text(i);
    },
  },
];

const CRM = [
  {
    name: 'list_customers',
    description: 'Customers with tier, late-delivery penalty and contact address.',
    inputSchema: obj(),
    run: () => text(W.customers),
  },
  {
    name: 'list_orders',
    description: 'Sales orders with promised delivery date, simulated expected delivery date and days late. Filter by customer or show only orders that are expected late or not yet planned.',
    inputSchema: obj({ customerId: str('Customer id, e.g. C-01'), riskOnly: { type: 'boolean', description: 'Only orders expected late, or not yet planned for production' } }),
    run: (a) =>
      text(
        W.salesOrders
          .filter((s) => !a.customerId || s.customerId === a.customerId)
          .map((s) => {
            const po = W.productionOrders.find((p) => p.salesOrderId === s.id);
            const v = po ? orderView(po) : null;
            const c = W.customers.find((x) => x.id === s.customerId);
            return { id: s.id, customer: `${c.id} ${c.name} (tier ${c.tier}, penalty ${c.penaltyPctPerWeekLate}%/week late)`, product: s.product, qty: s.qty, promisedDelivery: s.promisedDelivery, communicatedDelivery: s.communicatedDelivery, expectedDelivery: v ? (v.expected ?? 'not within 70 workdays') : 'not planned yet', daysLate: v ? v.late : null, status: s.status, source: s.source };
          })
          .filter((o) => !a.riskOnly || o.daysLate === null || o.daysLate > 0),
      ),
  },
  {
    name: 'get_order',
    description: 'One sales order in detail, including its production order.',
    inputSchema: obj({ orderId: str('Sales order id') }, ['orderId']),
    run: (a) => {
      const s = W.salesOrders.find((x) => x.id === a.orderId);
      if (!s) return err(`Unknown order ${a.orderId}`);
      const po = W.productionOrders.find((p) => p.salesOrderId === s.id);
      return text({ ...s, customer: W.customers.find((c) => c.id === s.customerId), production: po ? { ...po, ...(({ end, expected, late }) => ({ completion: end, expectedDelivery: expected, daysLate: late }))(orderView(po)) } : null });
    },
  },
  {
    name: 'list_campaigns',
    description: 'Marketing campaigns with period, status, budget level and observed effect on order intake.',
    inputSchema: obj(),
    run: () => text(W.campaigns),
  },
  {
    name: 'get_demand_trend',
    description: 'Weekly sofas ordered versus the plan (order intake trend), including orders that are not planned for production yet.',
    inputSchema: obj(),
    run: () => {
      const unplanned = W.salesOrders.filter((s) => !W.productionOrders.some((p) => p.salesOrderId === s.id));
      const base = SALES.reduce((a, r) => a + r[3], 0);
      const extra = unplanned.reduce((a, s) => a + s.qty, 0);
      return text({
        planBaselineSofas: base,
        confirmedUnplannedSofas: extra,
        intakeVsPlanPct: Math.round((extra / base) * 100),
        unplannedOrders: unplanned.map((s) => ({ id: s.id, customerId: s.customerId, product: s.product, qty: s.qty, promisedDelivery: s.promisedDelivery })),
        activeCampaigns: W.campaigns.filter((c) => c.status === 'active').map((c) => ({ id: c.id, dailyBudgetPct: c.dailyBudgetPct, until: c.to })),
        note: 'Campaign intake continues at the current rate while the campaign runs at 100% budget.',
      });
    },
  },
  {
    name: 'send_customer_notice',
    description: 'WRITE. Send a notice (e-mail) to a customer about their orders, for example a delivery delay. The mail is recorded, not delivered.',
    write: true,
    inputSchema: obj({ customerId: str('Customer id'), orderIds: { type: 'array', items: { type: 'string' }, description: 'Sales orders concerned' }, subject: str('Subject'), body: str('Message text') }, ['customerId', 'orderIds', 'subject', 'body']),
    run: (a) => {
      const c = W.customers.find((x) => x.id === a.customerId);
      if (!c) return err(`Unknown customer ${a.customerId}`);
      const n = { at: new Date().toISOString(), to: c.contact, customerId: c.id, orderIds: a.orderIds, subject: a.subject, body: a.body };
      W.customerNotices.push(n);
      record('crm.send_customer_notice', a, c.id);
      return text({ status: 'queued', to: c.contact, orderIds: a.orderIds });
    },
  },
  {
    name: 'update_delivery_date',
    description: 'WRITE. Record a new delivery date that was communicated to the customer for a sales order.',
    write: true,
    inputSchema: obj({ orderId: str('Sales order id'), newDate: str('YYYY-MM-DD'), reason: str('Reason given to the customer') }, ['orderId', 'newDate', 'reason']),
    run: (a) => {
      const s = W.salesOrders.find((x) => x.id === a.orderId);
      if (!s) return err(`Unknown order ${a.orderId}`);
      s.communicatedDelivery = a.newDate;
      record('crm.update_delivery_date', a, s.id);
      return text(s);
    },
  },
  {
    name: 'update_campaign',
    description: 'WRITE. Change a campaign: throttle the daily ad budget (percent of the normal budget, 0-100) or pause/resume it. Lower budget reduces new order intake after a few days.',
    write: true,
    inputSchema: obj({ campaignId: str('Campaign id'), dailyBudgetPct: num('0-100'), status: str('active or paused', { enum: ['active', 'paused'] }), reason: str('Reason') }, ['campaignId']),
    run: (a) => {
      const c = W.campaigns.find((x) => x.id === a.campaignId);
      if (!c) return err(`Unknown campaign ${a.campaignId}`);
      if (a.dailyBudgetPct != null) c.dailyBudgetPct = Math.min(100, Math.max(0, Number(a.dailyBudgetPct)));
      if (a.status) c.status = a.status;
      c.note = `${c.note} | Changed ${TODAY}: budget ${c.dailyBudgetPct}%, status ${c.status}${a.reason ? ` (${a.reason})` : ''}`.trim();
      record('crm.update_campaign', a, c.id);
      return text({ ...c, expectedEffect: `Order intake is expected to fall to about ${c.status === 'paused' ? 0 : c.dailyBudgetPct}% of the current rate within 3 days.` });
    },
  },
];

/* ------------------------------------------------------------------ MCP over HTTP (stateless JSON-RPC) */

const SERVERS = { erp: { name: 'sofa-erp', tools: ERP }, crm: { name: 'sofa-crm', tools: CRM } };

function rpc(server, msg) {
  const { id, method, params } = msg;
  const s = SERVERS[server];
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: s.name, version: '1.0.0' } } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      // MCP tool annotations: the platform enforces read-only planning and can exempt read-only tools from the guard
      return { jsonrpc: '2.0', id, result: { tools: s.tools.map(({ name, description, inputSchema, write }) => ({ name, description, inputSchema, annotations: { readOnlyHint: !write, ...(write ? { destructiveHint: ['write_off_stock', 'cancel_purchase_order'].includes(name) } : {}) } })) } };
    case 'tools/call': {
      const t = s.tools.find((x) => x.name === params?.name);
      if (!t) return { jsonrpc: '2.0', id, result: err(`Unknown tool ${params?.name}`) };
      try {
        const out = t.run(params?.arguments ?? {});
        if (t.write) console.log(JSON.stringify({ msg: 'write', tool: `${server}.${t.name}`, args: params?.arguments, error: out.isError ?? false }));
        return { jsonrpc: '2.0', id, result: out };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: err(`Tool failed: ${e.message}`) };
      }
    }
    default:
      return id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

const readBody = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data === undefined ? '' : JSON.stringify(data));
};

W = freshWorld();

/** A read-only status page ("what the ERP/CRM screen shows"), used for before/after screenshots. */
function dashboardHtml() {
  const k = kpi();
  const e = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const sim = simulate();
  const rows = W.salesOrders.map((so) => {
    const po = W.productionOrders.find((p) => p.salesOrderId === so.id);
    const v = po ? orderView(po) : null;
    const c = W.customers.find((x) => x.id === so.customerId);
    return { so, po, v, c };
  });
  const late = rows.filter((r) => !r.po || r.v.late === null || r.v.late > 0);
  const next = [];
  for (let d = nextWork(TODAY); next.length < 15; d = addWork(d, 1)) next.push(d);
  const cap = (f) => next.map((d) => capacity(f, d).cap);
  const bar = (n) => `<td class="n" style="background:rgba(31,95,173,${(n / 48).toFixed(2)});color:${n > 24 ? '#fff' : '#1d2733'}">${n}</td>`;
  const badge = (t, c) => `<span class="b ${c}">${e(t)}</span>`;
  const machines = W.machines.map((m) => `<tr><td>${m.id}</td><td>${e(m.name)}</td><td>${m.status === 'down' ? badge(`DOWN since ${m.downSince}`, 'r') : badge('running', 'g')}</td><td>${m.status === 'down' ? (downUntil(m) === FAR ? 'no repair scheduled' : `back ${downUntil(m)}`) : ''}</td></tr>`).join('');
  const stock = Object.keys(SKU).filter((s) => s !== 'SP-SPINDLE-220').map((s) => `<tr><td>${s}</td><td class="num">${usable(s).toLocaleString('en')} ${SKU[s].unit}</td><td>${sim.shortage[s] ? badge(`short from ${sim.shortage[s]}`, 'r') : badge('covered', 'g')}</td></tr>`).join('');
  const pos = W.purchaseOrders.filter((p) => p.status !== 'cancelled').map((p) => `<tr><td>${p.id}</td><td>${p.supplierId}</td><td>${p.sku}</td><td class="num">${p.qty.toLocaleString('en')}</td><td>${p.eta}</td><td>${p.status === 'delayed' ? badge('delayed', 'r') : badge(p.status, 'g')}</td></tr>`).join('');
  const orders = rows
    .map((r) => {
      const state = !r.po ? badge('not planned', 'r') : r.v.late === null ? badge('beyond horizon', 'r') : r.v.late > 0 ? badge(`${r.v.late} d late`, 'r') : badge('on time', 'g');
      return `<tr><td>${r.so.id}</td><td>${e(r.c.name)}</td><td>${r.so.product} × ${r.so.qty}</td><td>${r.so.promisedDelivery}</td><td>${r.v?.expected ?? '—'}</td><td>${state}</td><td>${r.so.communicatedDelivery ? badge(`informed: ${r.so.communicatedDelivery}`, 'a') : ''}</td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sofa company – ERP/CRM status</title><style>
body{font:14px/1.4 Roboto,'Segoe UI',Arial,sans-serif;background:#f4f6fa;color:#1d2733;margin:0;padding:20px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 8px}.sub{color:#5b6777;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}.card{background:#fff;border:1px solid #dfe3ea;border-radius:10px;padding:14px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px}.kpi{background:#fff;border:1px solid #dfe3ea;border-radius:10px;padding:10px 12px}.kpi b{display:block;font-size:22px}.kpi span{color:#5b6777;font-size:12px}
table{border-collapse:collapse;width:100%}td,th{padding:3px 6px;border-bottom:1px solid #eef0f4;text-align:left;font-size:13px}th{color:#5b6777;font-weight:500}td.num{text-align:right}
td.n{text-align:center;width:28px;font-size:11px;border:1px solid #fff;padding:4px 0}.b{display:inline-block;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:600}.g{background:#e3f4e4;color:#1b5e20}.r{background:#fde4e4;color:#b71c1c}.a{background:#fff1d6;color:#8a5a00}
</style></head><body>
<h1>Sofa company – ERP/CRM status</h1><div class="sub">Simulation date ${TODAY} · mock systems for the Wrigglets example · ${W.events.length ? `disruptions: ${W.events.join(', ')}` : 'no disruption'} · ${W.log.length} change(s) by agents</div>
<div class="kpis">
<div class="kpi"><b>${k.lateOrders}</b><span>orders expected late</span></div>
<div class="kpi"><b>${k.sofasLate}</b><span>sofas late</span></div>
<div class="kpi"><b>${k.unplannedOrders.length}</b><span>orders not planned</span></div>
<div class="kpi"><b>${k.lateOrdersCustomerNotInformed}</b><span>late, customer not informed</span></div>
<div class="kpi"><b>${Object.keys(k.materialShortages).length}</b><span>material shortages</span></div>
<div class="kpi"><b>€ ${k.costOfMeasuresEur.toLocaleString('en')}</b><span>cost of measures</span></div></div>
<div class="grid">
<div class="card"><h2>Capacity, sofas/day, next 15 workdays (from ${next[0]})</h2><table><tr><th>Werk Nord</th>${cap('F-NORTH').map(bar).join('')}</tr><tr><th>Werk Süd</th>${cap('F-SOUTH').map(bar).join('')}</tr></table>
<h2 style="margin-top:12px">Machines</h2><table>${machines}</table></div>
<div class="card"><h2>Material (usable stock)</h2><table>${stock}</table><h2 style="margin-top:12px">Purchase orders</h2><table>${pos}</table></div>
<div class="card" style="grid-column:1/-1"><h2>Sales orders (CRM) vs. simulated production</h2><table><tr><th>Order</th><th>Customer</th><th>Item</th><th>Promised</th><th>Expected</th><th>Status</th><th>Customer</th></tr>${orders}</table></div>
</div></body></html>`;
}

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/health') return send(res, 200, { status: 'ok' });
  if (path === '/' || path === '/dashboard') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(dashboardHtml());
  }
  if (path === '/kpi') return send(res, 200, kpi());
  if (path === '/log') return send(res, 200, W.log);
  if (path === '/notices') return send(res, 200, W.customerNotices);
  if (path === '/state') return send(res, 200, { events: W.events, kpi: kpi(), writtenOffEur: W.writtenOffEur ?? 0 });
  if (path === '/reset' && req.method === 'POST') {
    W = freshWorld();
    touch();
    return send(res, 200, { ok: true, kpi: kpi() });
  }
  const sc = path.match(/^\/scenario\/([a-z-]+)\/start$/);
  if (sc && req.method === 'POST') {
    if (!SCENARIOS[sc[1]]) return send(res, 404, { error: 'unknown scenario', known: Object.keys(SCENARIOS) });
    SCENARIOS[sc[1]]();
    W.events.push(sc[1]);
    touch();
    return send(res, 200, { ok: true, scenario: sc[1], kpi: kpi() });
  }
  const m = path.match(/^\/(erp|crm)\/mcp$/);
  if (m && req.method === 'POST') {
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null });
    }
    if (Array.isArray(msg)) {
      const out = msg.map((x) => rpc(m[1], x)).filter(Boolean);
      return out.length ? send(res, 200, out) : send(res, 202);
    }
    const out = rpc(m[1], msg);
    return out ? send(res, 200, out) : send(res, 202);
  }
  send(res, 405, { error: 'method not allowed' });
}).listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ msg: 'sofa-company mock MCP listening', port: PORT, auth: 'none', endpoints: ['/erp/mcp', '/crm/mcp'] })));
