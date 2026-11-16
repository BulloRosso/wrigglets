import { CAMPAIGN_SALES, PRODUCTS, SALES, SHIPPING_DAYS, SKU, TODAY, freshWorld, productionOrder, type FactoryId, type ProductionOrder, type Sequences, type World } from './world.js';

/*
 * The sofa company's business logic, ported 1:1 from scripts/sofa-company/mock-mcp.mjs (plan M3). The mock is the
 * reference: parity tests run the same calls against both and compare the answers byte for byte. Differences to the
 * mock: state is an instance (world + id sequences) instead of module globals, and the write log is kept by the caller
 * (the event log), so `writes` in the KPI is passed in.
 */

export const HORIZON_WORKDAYS = 70;
export const FAR = '9999-12-31';

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(D(s).getTime() + n * 86_400_000));
const diffDays = (a: string, b: string) => Math.round((D(a).getTime() - D(b).getTime()) / 86_400_000);
const isWork = (s: string) => ![0, 6].includes(D(s).getUTCDay());
const nextWork = (s: string) => {
  while (!isWork(s)) s = addDays(s, 1);
  return s;
};
const addWork = (s: string, n: number) => {
  for (let c = 0; c < n; ) {
    s = addDays(s, 1);
    if (isWork(s)) c++;
  }
  return s;
};

/** Mutable extras of the mock world that the ontology keeps as company-level values. */
export interface CompanyWorld extends World {
  writtenOffEur?: number;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}
export type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const text = (t: unknown, isError = false): ToolResult => ({ text: typeof t === 'string' ? t : JSON.stringify(t, null, 1), isError });
const err = (m: string) => text(m, true);

export interface WriteRecord {
  tool: string;
  args: Args;
  result: string;
}

export const SCENARIO_IDS = ['supplier-beams', 'machine-failure', 'demand-spike', 'sick-leave', 'storm'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export class SofaCompany {
  W: CompanyWorld;
  seq: Sequences;
  /** Number of writes so far (the mock's W.log.length); kept by the event log. */
  writes = 0;
  /** Set by a write tool: what the mock would append to its log (tool, args, result). */
  lastWrite?: WriteRecord;
  private simCache?: ReturnType<SofaCompany['computeSim']>;

  constructor(state?: { world: CompanyWorld; seq: Sequences; writes?: number }) {
    const s = state ?? freshWorld();
    this.W = s.world;
    this.seq = s.seq;
    this.writes = state?.writes ?? 0;
  }

  /** A deep copy that can be changed without touching this instance (what-if, transactions). */
  clone(): SofaCompany {
    return new SofaCompany({ world: structuredClone(this.W), seq: { ...this.seq }, writes: this.writes });
  }

  touch() {
    this.simCache = undefined;
  }

  /* ------------------------------------------------------------------ capacity and simulation */

  downUntil(m: CompanyWorld['machines'][number]): string | null {
    if (m.status !== 'down') return null;
    const t = this.W.tickets.find((x) => x.machineId === m.id && x.status === 'open');
    const part = t && this.W.purchaseOrders.find((p) => p.sku === t.requiredPart && p.status === 'open');
    return part ? addWork(part.eta, 2) : FAR; // repair takes 2 workdays after the spare part has arrived
  }

  private machineDownOn(m: CompanyWorld['machines'][number], d: string) {
    return m.status === 'down' && d >= (m.downSince as string) && d <= (this.downUntil(m) as string);
  }

  capacity(f: string, d: string): { cap: number; reason: string } {
    if (!isWork(d)) return { cap: 0, reason: 'non-working day' };
    const down = this.W.machines.filter((m) => m.factory === f && this.machineDownOn(m, d));
    if (down.length) return { cap: 0, reason: `machine down: ${down.map((m) => m.id).join(', ')}` };
    const staff = this.W.workers.filter((x) => x.factory === f);
    const present = staff.filter((x) => !x.absences.some((a) => a.from <= d && d <= a.to)).length;
    const temps = this.W.temp.filter((t) => t.factory === f && t.from <= d && d <= t.to).reduce((s, t) => s + t.count, 0);
    let base = present * 20 + temps * 15;
    const ot = this.W.overtime.some((o) => o.factory === f && o.from <= d && d <= o.to);
    if (ot && base > 0) base = Math.round(base * 1.25);
    const cap = Math.min(48, base);
    const why = [`${present}/${staff.length} regular workers`];
    if (temps) why.push(`${temps} temp worker(s)`);
    if (ot) why.push('overtime');
    return { cap, reason: why.join(', ') };
  }

  usable(sku: string) {
    return this.W.lots.filter((l) => l.sku === sku && l.status === 'ok').reduce((s, l) => s + l.qty, 0);
  }

  private computeSim() {
    const stock: Record<string, number> = Object.fromEntries(Object.keys(SKU).map((k) => [k, this.usable(k)]));
    const inbound = this.W.purchaseOrders.filter((p) => p.status === 'open' || p.status === 'delayed');
    const produced: Record<string, number> = Object.fromEntries(this.W.productionOrders.map((p) => [p.id, 0]));
    const done: Record<string, string> = {};
    const blocked: Record<string, { sku: string; firstDate: string }> = {};
    const shortage: Record<string, string> = {};
    const days: Array<{ date: string; produced: Record<string, number>; stock: Record<string, number>; stockEnd?: Record<string, number> }> = [];
    let d = nextWork(TODAY);
    for (let i = 0; i < HORIZON_WORKDAYS; i++, d = addWork(d, 1)) {
      for (const p of inbound) if (nextWork(p.eta) === d) stock[p.sku] = (stock[p.sku] ?? 0) + p.qty;
      const row: (typeof days)[number] = { date: d, produced: { 'F-NORTH': 0, 'F-SOUTH': 0 }, stock: { ...stock } };
      for (const f of Object.keys(this.W.factories)) {
        let cap = this.capacity(f, d).cap;
        const queue = this.W.productionOrders.filter((p) => p.factory === f && produced[p.id]! < p.qty).sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
        for (const o of queue) {
          if (cap <= 0) break;
          const bom = PRODUCTS[o.product];
          const limits: Record<string, number> = { 'BEAM-PINE-80': Math.floor(stock['BEAM-PINE-80']! / bom.beams), [o.fabric]: Math.floor(stock[o.fabric]! / bom.fabricM), 'FOAM-HR35': Math.floor(stock['FOAM-HR35']! / bom.foam) };
          const want = Math.min(cap, o.qty - produced[o.id]!);
          const [limSku, lim] = Object.entries(limits).sort((a, b) => a[1] - b[1])[0]!;
          const n = Math.min(want, lim);
          if (n < want) {
            blocked[o.id] ??= { sku: limSku, firstDate: d };
            shortage[limSku] ??= d;
          }
          if (n <= 0) continue;
          stock['BEAM-PINE-80']! -= n * bom.beams;
          stock[o.fabric]! -= n * bom.fabricM;
          stock['FOAM-HR35']! -= n * bom.foam;
          produced[o.id]! += n;
          cap -= n;
          row.produced[f]! += n;
          if (produced[o.id]! >= o.qty) done[o.id] = d;
        }
      }
      row.stockEnd = { ...stock };
      days.push(row);
    }
    return { done, blocked, shortage, days };
  }

  simulate() {
    return (this.simCache ??= this.computeSim());
  }

  orderView(po: ProductionOrder) {
    const sim = this.simulate();
    const so = this.W.salesOrders.find((s) => s.id === po.salesOrderId)!;
    const end = sim.done[po.id] ?? null;
    const expected = end ? addDays(end, SHIPPING_DAYS) : null;
    return { so, end, expected, late: expected ? Math.max(0, diffDays(expected, so.promisedDelivery)) : null, blocked: sim.blocked[po.id] };
  }

  kpi() {
    const sim = this.simulate();
    const rows = this.W.salesOrders.map((so) => {
      const po = this.W.productionOrders.find((p) => p.salesOrderId === so.id);
      if (!po) return { so, planned: false as const };
      const v = this.orderView(po);
      return { so, planned: true as const, expected: v.expected, late: v.late ?? 999 };
    });
    const late = rows.filter((r) => r.planned && r.late > 0) as Array<{ so: (typeof rows)[number]['so']; late: number }>;
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
      costOfMeasuresEur: Math.round(this.W.costEur),
      writes: this.writes,
    };
  }

  /* ------------------------------------------------------------------ scenarios */

  scenario(id: ScenarioId) {
    const W = this.W;
    switch (id) {
      case 'supplier-beams': {
        const s = W.suppliers.find((x) => x.id === 'S-NORDHOLZ')!;
        s.status = 'cannot_deliver';
        s.notice = 'Sawmill Nordholz, 2026-10-05: storm damage to our drying kilns. We cannot deliver pine beams before 2026-11-30. PO-4411 and PO-4418 are postponed. Sorry.';
        for (const p of W.purchaseOrders.filter((x) => x.supplierId === 'S-NORDHOLZ')) {
          p.status = 'delayed';
          p.eta = p.id === 'PO-4411' ? '2026-11-30' : '2026-12-14';
          p.note = 'Postponed by the supplier (kiln damage)';
        }
        break;
      }
      case 'machine-failure': {
        const m = W.machines.find((x) => x.id === 'N-CUT-1')!;
        m.status = 'down';
        m.downSince = TODAY;
        m.note = 'Drive error E-4410 on the spindle. Diagnosis by the shift lead: spindle motor SP-SPINDLE-220 is defective and must be replaced; no spare in the warehouse.';
        break;
      }
      case 'demand-spike':
        for (const [sid, customerId, product, qty, fabric, promised] of CAMPAIGN_SALES)
          W.salesOrders.push({ id: sid, customerId, product, qty, fabric, promisedDelivery: promised, communicatedDelivery: null, status: 'confirmed_unplanned', source: 'campaign CMP-HERBST' } as World['salesOrders'][number]);
        W.campaigns[0]!.note = 'Order intake since 2026-10-01 is 42% above plan; the campaign runs until 2026-10-31.';
        break;
      case 'sick-leave':
        for (const w of W.workers.filter((x) => x.factory === 'F-SOUTH')) w.absences.push({ from: '2026-10-12', to: '2026-10-23', reason: 'sick leave (certificate received)' });
        break;
      case 'storm': {
        const hit: Record<string, string> = { 'L-OAT-231': '7,200 m water-damaged (mould risk, not usable); 1,800 m dry and usable', 'L-ANTH-219': '6,800 m water-damaged (mould risk, not usable); 1,700 m dry and usable' };
        for (const [lid, verdict] of Object.entries(hit)) {
          const l = W.lots.find((x) => x.id === lid)!;
          l.status = 'quarantined';
          l.note = `Storm 2026-10-04: roof leak in the fabric hall. Surveyor report 2026-10-05: ${verdict}. Disposition pending.`;
        }
        break;
      }
    }
    W.events.push(id);
    this.touch();
  }

  /* ------------------------------------------------------------------ tools */

  private record(tool: string, args: Args, result: string) {
    this.writes++;
    this.lastWrite = { tool, args, result };
    this.touch();
  }

  readonly writeTools = new Set(['release_purchase_order', 'create_purchase_order', 'cancel_purchase_order', 'create_maintenance_ticket', 'update_production_order', 'create_production_order', 'request_overtime', 'request_temp_workers', 'write_off_stock', 'release_stock', 'file_incident_report', 'send_customer_notice', 'update_delivery_date', 'update_campaign']);
  private readonly erpWrites = ['create_purchase_order', 'cancel_purchase_order', 'create_maintenance_ticket', 'update_production_order', 'create_production_order', 'request_overtime', 'request_temp_workers', 'write_off_stock', 'release_stock', 'file_incident_report'];

  /** Runs a tool by name, exactly like the mock's tools/call (errors as isError results, never throws for bad input). */
  call(name: string, a: Args = {}): ToolResult {
    if (!this.has(name)) return err(`Unknown tool ${name}`);
    try {
      return this.run(name, a ?? {});
    } catch (e) {
      return err(`Tool failed: ${(e as Error).message}`);
    }
  }

  has(name: string) {
    return Object.hasOwn(this.tools, name);
  }

  /** Runs a tool without catching (what-if uses this, like the mock's simulate_change). */
  run(name: string, a: Args): ToolResult {
    return (this.tools as Record<string, (a: Args) => ToolResult>)[name]!(a);
  }

  private readonly tools = {
    get_overview: (): ToolResult => {
      const W = this.W;
      const alerts: unknown[] = [];
      for (const m of W.machines.filter((x) => x.status === 'down'))
        alerts.push({ type: 'machine_down', machine: m.id, factory: m.factory, since: m.downSince, note: m.note, maintenanceTicket: W.tickets.find((t) => t.machineId === m.id && t.status === 'open')?.id ?? 'none yet', backInService: this.downUntil(m) === FAR ? 'unknown (no repair scheduled)' : this.downUntil(m) });
      for (const w of W.workers) for (const ab of w.absences) alerts.push({ type: 'absence', worker: w.name, factory: w.factory, from: ab.from, to: ab.to, reason: ab.reason });
      for (const s of W.suppliers.filter((x) => x.status !== 'ok')) alerts.push({ type: 'supplier', supplier: s.id, status: s.status, notice: s.notice });
      for (const l of W.lots.filter((x) => x.status === 'quarantined')) alerts.push({ type: 'stock_quarantined', lot: l.id, sku: l.sku, qty: l.qty, note: l.note });
      const unplanned = W.salesOrders.filter((s) => !W.productionOrders.some((p) => p.salesOrderId === s.id));
      if (unplanned.length) alerts.push({ type: 'unplanned_sales_orders', count: unplanned.length, sofas: unplanned.reduce((x, s) => x + s.qty, 0), orders: unplanned.map((s) => s.id) });
      const next: string[] = [];
      for (let d = nextWork(TODAY); next.length < 10; d = addWork(d, 1)) next.push(d);
      const fac = Object.keys(W.factories).map((f) => ({ id: f, name: W.factories[f as FactoryId].name, machines: W.machines.filter((m) => m.factory === f).map((m) => `${m.id} ${m.status}`), sofasPerDayNext10Workdays: next.map((d) => this.capacity(f, d).cap) }));
      return text({ simulationDate: TODAY, factories: fac, alerts, kpi: this.kpi() });
    },

    get_kpi: (): ToolResult => text(this.kpi()),

    simulate_change: (a: Args): ToolResult => {
      const list: Array<{ tool: string; arguments?: Args }> = Array.isArray(a.changes) && a.changes.length ? a.changes : a.tool ? [{ tool: a.tool, arguments: a.arguments ?? {} }] : [];
      if (!list.length) return err('Give "tool" and "arguments", or a list "changes".');
      const unknown = list.find((c) => !this.erpWrites.includes(c.tool));
      if (unknown) return err(`Unknown change tool ${unknown.tool}. Known: ${this.erpWrites.join(', ')}`);
      const pick = (k: ReturnType<SofaCompany['kpi']>) => ({ lateOrders: k.lateOrders, sofasLate: k.sofasLate, unplannedOrders: k.unplannedOrders.length, lateWithoutCustomerNotice: k.lateOrdersCustomerNotInformed, materialShortages: k.materialShortages, costOfMeasuresEur: k.costOfMeasuresEur });
      const before = pick(this.kpi());
      const copy = this.clone();
      const results = list.slice(0, 12).map((c) => {
        const out = copy.run(c.tool, c.arguments ?? {});
        return { tool: c.tool, wouldSucceed: !out.isError, answer: out.text.slice(0, 300) };
      });
      return text({ results, kpiBefore: before, kpiAfter: pick(copy.kpi()), note: 'Simulation only: nothing was changed.' });
    },

    list_machines: (a: Args): ToolResult =>
      text(this.W.machines.filter((m) => !a.factory || m.factory === a.factory).map((m) => ({ ...m, ticket: this.W.tickets.find((t) => t.machineId === m.id && t.status === 'open') ?? null, backInService: m.status === 'down' ? (this.downUntil(m) === FAR ? 'unknown' : this.downUntil(m)) : null }))),

    list_workers: (a: Args): ToolResult =>
      text({ workers: this.W.workers.filter((w) => !a.factory || w.factory === a.factory), temporaryWorkers: this.W.temp, overtime: this.W.overtime, rule: 'A regular worker delivers 20 sofas/day, a temporary worker 15; a factory tops out at 48 sofas/day; overtime adds 25%.' }),

    get_capacity: (a: Args): ToolResult => {
      if (!this.W.factories[a.factory as FactoryId]) return err(`Unknown factory ${a.factory}`);
      const rows: unknown[] = [];
      for (let d = nextWork(TODAY); rows.length < Math.min(Number(a.days ?? 15), 60); d = addWork(d, 1)) rows.push({ date: d, ...this.capacity(a.factory, d) });
      return text({ factory: a.factory, rows });
    },

    list_production_orders: (a: Args): ToolResult =>
      text(
        this.W.productionOrders
          .filter((p) => !a.factory || p.factory === a.factory)
          .map((p) => ({ p, v: this.orderView(p) }))
          .filter(({ v }) => !a.lateOnly || v.late === null || v.late > 0)
          .map(({ p, v }) => ({ id: p.id, salesOrder: p.salesOrderId, factory: p.factory, product: p.product, fabric: p.fabric, qty: p.qty, priority: p.priority, productionDue: p.dueDate, completion: v.end ?? 'not within 70 workdays', expectedDelivery: v.expected, promisedDelivery: v.so.promisedDelivery, daysLate: v.late, heldBackBy: v.blocked ? `${v.blocked.sku} from ${v.blocked.firstDate}` : null })),
      ),

    get_inventory: (a: Args): ToolResult => {
      const lots = this.W.lots.filter((l) => !a.sku || l.sku === a.sku);
      const skus = [...new Set(lots.map((l) => l.sku))];
      return text({ skus: skus.map((k) => ({ sku: k, name: SKU[k]?.name, unit: SKU[k]?.unit, usable: this.usable(k), totalOnHand: lots.filter((l) => l.sku === k).reduce((s, l) => s + l.qty, 0) })), lots });
    },

    get_material_projection: (a: Args): ToolResult => {
      if (!SKU[a.sku]) return err(`Unknown SKU ${a.sku}. Known: ${Object.keys(SKU).join(', ')}`);
      const sim = this.simulate();
      return text({
        sku: a.sku,
        usableNow: this.usable(a.sku),
        openPurchaseOrders: this.W.purchaseOrders.filter((p) => p.sku === a.sku && p.status !== 'cancelled').map((p) => ({ id: p.id, qty: p.qty, eta: p.eta, status: p.status })),
        firstShortage: sim.shortage[a.sku] ? `production is held back from ${sim.shortage[a.sku]}` : 'no shortage within 70 workdays',
        weeklyEndOfWeekStock: sim.days
          .filter((r) => D(r.date).getUTCDay() === 5)
          .slice(0, 8)
          .map((r) => ({ week_ending: r.date, stock: r.stockEnd![a.sku] })),
      });
    },

    list_purchase_orders: (a: Args): ToolResult => text(this.W.purchaseOrders.filter((p) => !a.sku || p.sku === a.sku)),
    list_suppliers: (a: Args): ToolResult => text(this.W.suppliers.filter((s) => !a.sku || s.skus.includes(a.sku))),
    get_bom: (a: Args): ToolResult => text(a.product ? (PRODUCTS[String(a.product).toUpperCase() as keyof typeof PRODUCTS] ?? `Unknown product ${a.product}`) : PRODUCTS),
    list_maintenance_tickets: (): ToolResult => text(this.W.tickets),

    /* ---- ERP writes ---- */
    create_purchase_order: (a: Args): ToolResult => {
      const s = this.W.suppliers.find((x) => x.id === a.supplierId);
      if (!s) return err(`Unknown supplier ${a.supplierId}`);
      if (s.status !== 'ok') return err(`Supplier ${s.id} cannot deliver at the moment: ${s.notice}`);
      if (!s.skus.includes(a.sku)) return err(`${s.id} does not supply ${a.sku}`);
      const q = Number(a.quantity);
      if (!(q >= s.minQty && q <= s.maxQty)) return err(`Quantity must be between ${s.minQty} and ${s.maxQty} for ${s.id}`);
      if (a.express && s.expressLeadWorkdays == null) return err(`${s.id} offers no express delivery`);
      const lead = a.express ? s.expressLeadWorkdays! : s.leadWorkdays;
      const unit = s.unitPrice + (a.express ? s.expressSurchargePerUnit : 0);
      const po = { id: `PO-${this.seq.po++}`, supplierId: s.id, sku: a.sku, qty: q, unitPrice: unit, eta: addWork(TODAY, lead), originalEta: addWork(TODAY, lead), status: 'open', express: !!a.express, note: a.note ?? '' };
      this.W.purchaseOrders.push(po);
      this.W.costEur += q * unit;
      this.record('erp.create_purchase_order', a, po.id);
      return text({ ...po, totalEur: Math.round(q * unit) });
    },

    /** Not in the mock: step of the PurchaseOrderRelease business workflow (M5). Served on /onto only. */
    release_purchase_order: (a: Args): ToolResult => {
      const p = this.W.purchaseOrders.find((x) => x.id === a.poId);
      if (!p) return err(`Unknown purchase order ${a.poId}`);
      if (p.status !== 'open' && p.status !== 'delayed') return err(`${p.id} is ${p.status}; only open or delayed orders can be released`);
      if (p.releasedAt) return err(`${p.id} was already released on ${p.releasedAt}`);
      p.releasedAt = TODAY;
      this.record('erp.release_purchase_order', a, p.id);
      return text(p);
    },

    cancel_purchase_order: (a: Args): ToolResult => {
      const p = this.W.purchaseOrders.find((x) => x.id === a.poId);
      if (!p) return err(`Unknown purchase order ${a.poId}`);
      p.status = 'cancelled';
      p.note = a.reason;
      this.record('erp.cancel_purchase_order', a, p.id);
      return text(p);
    },

    create_maintenance_ticket: (a: Args): ToolResult => {
      const m = this.W.machines.find((x) => x.id === a.machineId);
      if (!m) return err(`Unknown machine ${a.machineId}`);
      if (m.status !== 'down') return err(`${m.id} is running; no ticket needed`);
      if (this.W.tickets.some((t) => t.machineId === m.id && t.status === 'open')) return err(`There is already an open ticket for ${m.id}`);
      const t = { id: `MT-${String(this.seq.ticket++).padStart(3, '0')}`, machineId: m.id, description: a.description, requiredPart: a.requiredPart ?? 'SP-SPINDLE-220', status: 'open', technicianBooked: nextWork(addDays(TODAY, 1)), openedAt: TODAY };
      this.W.tickets.push(t);
      this.W.costEur += 450; // call-out fee
      this.record('erp.create_maintenance_ticket', a, t.id);
      return text({ ...t, hint: 'Repair can only start once the spare part is delivered. Place a purchase order for it if none exists.' });
    },

    update_production_order: (a: Args): ToolResult => {
      const p = this.W.productionOrders.find((x) => x.id === a.orderId);
      if (!p) return err(`Unknown production order ${a.orderId}`);
      if (a.factory) {
        if (!this.W.factories[a.factory as FactoryId]) return err(`Unknown factory ${a.factory}`);
        p.factory = a.factory;
      }
      if (a.priority != null) p.priority = Math.min(9, Math.max(1, Number(a.priority)));
      this.record('erp.update_production_order', a, p.id);
      return text({ ...p, completion: this.orderView(p).end, expectedDelivery: this.orderView(p).expected, daysLate: this.orderView(p).late });
    },

    create_production_order: (a: Args): ToolResult => {
      const s = this.W.salesOrders.find((x) => x.id === a.salesOrderId);
      if (!s) return err(`Unknown sales order ${a.salesOrderId}`);
      if (this.W.productionOrders.some((p) => p.salesOrderId === s.id)) return err(`${s.id} already has a production order`);
      if (!this.W.factories[a.factory as FactoryId]) return err(`Unknown factory ${a.factory}`);
      const p = productionOrder(s, a.factory, this.seq);
      if (a.priority != null) p.priority = Math.min(9, Math.max(1, Number(a.priority)));
      this.W.productionOrders.push(p);
      s.status = 'confirmed';
      this.record('erp.create_production_order', a, p.id);
      return text({ ...p, completion: this.orderView(p).end, expectedDelivery: this.orderView(p).expected, daysLate: this.orderView(p).late });
    },

    request_overtime: (a: Args): ToolResult => {
      if (!this.W.factories[a.factory as FactoryId]) return err(`Unknown factory ${a.factory}`);
      if (a.from < TODAY || a.to < a.from) return err('Invalid date range');
      let days = 0;
      for (let d = a.from; d <= a.to; d = addDays(d, 1)) if (isWork(d)) days++;
      this.W.overtime.push({ factory: a.factory, from: a.from, to: a.to });
      this.W.costEur += days * 1400;
      this.record('erp.request_overtime', a, `${days} days`);
      return text({ factory: a.factory, from: a.from, to: a.to, workdays: days, costEur: days * 1400 });
    },

    request_temp_workers: (a: Args): ToolResult => {
      if (!this.W.factories[a.factory as FactoryId]) return err(`Unknown factory ${a.factory}`);
      const count = Math.round(Number(a.count));
      if (!(count >= 1 && count <= 4)) return err('count must be 1-4');
      const earliest = addWork(TODAY, 3);
      const from = a.from < earliest ? earliest : a.from;
      if (a.to < from) return err(`Agency can start on ${earliest} at the earliest`);
      let days = 0;
      for (let d = from; d <= a.to; d = addDays(d, 1)) if (isWork(d)) days++;
      this.W.temp.push({ factory: a.factory, count, from, to: a.to });
      this.W.costEur += days * count * 260;
      this.record('erp.request_temp_workers', a, `${count} x ${days} days`);
      return text({ factory: a.factory, count, from, to: a.to, workdays: days, costEur: days * count * 260, note: from !== a.from ? `Start moved to ${from} (agency lead time)` : undefined });
    },

    write_off_stock: (a: Args): ToolResult => {
      const l = this.W.lots.find((x) => x.id === a.lotId);
      if (!l) return err(`Unknown lot ${a.lotId}`);
      const q = Number(a.quantity);
      if (!(q > 0 && q <= l.qty)) return err(`Quantity must be between 1 and ${l.qty}`);
      l.qty -= q;
      const value = Math.round(q * (SKU[l.sku]?.cost ?? 0));
      this.W.writtenOffEur = (this.W.writtenOffEur ?? 0) + value;
      this.record('erp.write_off_stock', a, `${q} ${l.sku}`);
      return text({ lot: l.id, writtenOff: q, valueEur: value, remainingInLot: l.qty, status: l.status });
    },

    release_stock: (a: Args): ToolResult => {
      const l = this.W.lots.find((x) => x.id === a.lotId);
      if (!l) return err(`Unknown lot ${a.lotId}`);
      if (l.status !== 'quarantined') return err(`Lot ${l.id} is not quarantined`);
      const q = Number(a.quantity);
      if (!(q > 0 && q <= l.qty)) return err(`Quantity must be between 1 and ${l.qty}`);
      l.qty -= q;
      this.W.lots.push({ id: `${l.id}-R`, sku: l.sku, qty: q, location: l.location, status: 'ok', note: `Released after inspection. ${a.note ?? ''}`.trim() });
      this.record('erp.release_stock', a, `${q} ${l.sku}`);
      return text({ released: q, newLot: `${l.id}-R`, stillQuarantined: l.qty });
    },

    file_incident_report: (a: Args): ToolResult => {
      const i = { id: `INC-${String(this.seq.inc++).padStart(4, '0')}`, ...a, claim: 'prepared for the insurer', filedAt: TODAY };
      this.W.incidents.push(i);
      this.record('erp.file_incident_report', a, i.id);
      return text(i);
    },

    /* ---- CRM ---- */
    list_customers: (): ToolResult => text(this.W.customers),

    list_orders: (a: Args): ToolResult =>
      text(
        this.W.salesOrders
          .filter((s) => !a.customerId || s.customerId === a.customerId)
          .map((s) => {
            const po = this.W.productionOrders.find((p) => p.salesOrderId === s.id);
            const v = po ? this.orderView(po) : null;
            const c = this.W.customers.find((x) => x.id === s.customerId)!;
            return { id: s.id, customer: `${c.id} ${c.name} (tier ${c.tier}, penalty ${c.penaltyPctPerWeekLate}%/week late)`, product: s.product, qty: s.qty, promisedDelivery: s.promisedDelivery, communicatedDelivery: s.communicatedDelivery, expectedDelivery: v ? (v.expected ?? 'not within 70 workdays') : 'not planned yet', daysLate: v ? v.late : null, status: s.status, source: (s as { source?: string }).source };
          })
          .filter((o) => !a.riskOnly || o.daysLate === null || o.daysLate > 0),
      ),

    get_order: (a: Args): ToolResult => {
      const s = this.W.salesOrders.find((x) => x.id === a.orderId);
      if (!s) return err(`Unknown order ${a.orderId}`);
      const po = this.W.productionOrders.find((p) => p.salesOrderId === s.id);
      const view = po ? this.orderView(po) : undefined;
      return text({ ...s, customer: this.W.customers.find((c) => c.id === s.customerId), production: po && view ? { ...po, completion: view.end, expectedDelivery: view.expected, daysLate: view.late } : null });
    },

    list_campaigns: (): ToolResult => text(this.W.campaigns),

    get_demand_trend: (): ToolResult => {
      const unplanned = this.W.salesOrders.filter((s) => !this.W.productionOrders.some((p) => p.salesOrderId === s.id));
      const base = SALES.reduce((x, r) => x + r[3], 0);
      const extra = unplanned.reduce((x, s) => x + s.qty, 0);
      return text({
        planBaselineSofas: base,
        confirmedUnplannedSofas: extra,
        intakeVsPlanPct: Math.round((extra / base) * 100),
        unplannedOrders: unplanned.map((s) => ({ id: s.id, customerId: s.customerId, product: s.product, qty: s.qty, promisedDelivery: s.promisedDelivery })),
        activeCampaigns: this.W.campaigns.filter((c) => c.status === 'active').map((c) => ({ id: c.id, dailyBudgetPct: c.dailyBudgetPct, until: c.to })),
        note: 'Campaign intake continues at the current rate while the campaign runs at 100% budget.',
      });
    },

    send_customer_notice: (a: Args): ToolResult => {
      const c = this.W.customers.find((x) => x.id === a.customerId);
      if (!c) return err(`Unknown customer ${a.customerId}`);
      const n = { at: new Date().toISOString(), to: c.contact, customerId: c.id, orderIds: a.orderIds, subject: a.subject, body: a.body };
      this.W.customerNotices.push(n);
      this.record('crm.send_customer_notice', a, c.id);
      return text({ status: 'queued', to: c.contact, orderIds: a.orderIds });
    },

    update_delivery_date: (a: Args): ToolResult => {
      const s = this.W.salesOrders.find((x) => x.id === a.orderId);
      if (!s) return err(`Unknown order ${a.orderId}`);
      s.communicatedDelivery = a.newDate;
      this.record('crm.update_delivery_date', a, s.id);
      return text(s);
    },

    update_campaign: (a: Args): ToolResult => {
      const c = this.W.campaigns.find((x) => x.id === a.campaignId);
      if (!c) return err(`Unknown campaign ${a.campaignId}`);
      if (a.dailyBudgetPct != null) c.dailyBudgetPct = Math.min(100, Math.max(0, Number(a.dailyBudgetPct)));
      if (a.status) c.status = a.status;
      c.note = `${c.note} | Changed ${TODAY}: budget ${c.dailyBudgetPct}%, status ${c.status}${a.reason ? ` (${a.reason})` : ''}`.trim();
      this.record('crm.update_campaign', a, c.id);
      return text({ ...c, expectedEffect: `Order intake is expected to fall to about ${c.status === 'paused' ? 0 : c.dailyBudgetPct}% of the current rate within 3 days.` });
    },
  };
}
