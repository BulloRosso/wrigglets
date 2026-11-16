/*
 * The sofa company's world (scripts/sofa-company/mock-mcp.mjs), ported to TypeScript for Liquid Enterprise.
 * The numbers must stay identical to the mock: a parity test compares freshWorld() with the mock's export.
 * M1 uses the initial state for the T0 extract; M3 ports the simulation, KPI and write tools onto this model.
 */

export const TODAY = '2026-10-05'; // a Monday
export const SHIPPING_DAYS = 3;

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => iso(new Date(D(s).getTime() + n * 86_400_000));

export type ProductId = 'LUND' | 'OSLO' | 'BERGEN';
export type FactoryId = 'F-NORTH' | 'F-SOUTH';

export const PRODUCTS: Record<ProductId, { name: string; beams: number; fabricM: number; foam: number }> = {
  LUND: { name: 'Lund 2-seater', beams: 6, fabricM: 6, foam: 2 },
  OSLO: { name: 'Oslo 3-seater', beams: 8, fabricM: 8, foam: 3 },
  BERGEN: { name: 'Bergen corner sofa', beams: 12, fabricM: 13, foam: 4 },
};

export const SKU: Record<string, { name: string; unit: string; cost: number }> = {
  'BEAM-PINE-80': { name: 'Pine beam 80 mm (frame)', unit: 'pcs', cost: 4.2 },
  'FAB-OAT-01': { name: 'Upholstery fabric Oatmeal', unit: 'm', cost: 11.8 },
  'FAB-ANTH-02': { name: 'Upholstery fabric Anthracite', unit: 'm', cost: 11.8 },
  'FOAM-HR35': { name: 'HR35 foam block', unit: 'pcs', cost: 9.5 },
  'SP-SPINDLE-220': { name: 'Spare part: CNC spindle motor 220', unit: 'pcs', cost: 6800 },
};

type SalesRow = [id: string, customerId: string, product: ProductId, qty: number, fabric: string, promised: string];

export const SALES: SalesRow[] = [
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

/** Orders caused by the autumn campaign (injected by the demand-spike scenario). */
export const CAMPAIGN_SALES: SalesRow[] = [
  ['SO-2301', 'C-06', 'LUND', 130, 'FAB-OAT-01', '2026-10-26'],
  ['SO-2302', 'C-06', 'OSLO', 100, 'FAB-ANTH-02', '2026-10-29'],
  ['SO-2303', 'C-04', 'LUND', 150, 'FAB-OAT-01', '2026-11-04'],
  ['SO-2304', 'C-02', 'OSLO', 110, 'FAB-OAT-01', '2026-11-09'],
  ['SO-2305', 'C-05', 'LUND', 130, 'FAB-ANTH-02', '2026-11-12'],
  ['SO-2306', 'C-06', 'LUND', 170, 'FAB-OAT-01', '2026-11-16'],
  ['SO-2307', 'C-03', 'OSLO', 120, 'FAB-ANTH-02', '2026-11-19'],
  ['SO-2308', 'C-06', 'BERGEN', 60, 'FAB-OAT-01', '2026-11-24'],
];

export interface Machine { id: string; factory: FactoryId; name: string; ratePerDay: number; status: string; downSince: string | null; note: string }
export interface Absence { from: string; to: string; reason?: string }
export interface Worker { id: string; name: string; factory: FactoryId; absences: Absence[] }
export interface Supplier {
  id: string; name: string; skus: string[]; leadWorkdays: number; unitPrice: number; minQty: number; maxQty: number;
  expressLeadWorkdays: number | null; expressSurchargePerUnit: number; rating: string; status: string; notice: string | null;
}
export interface Lot { id: string; sku: string; qty: number; location: string; status: string; note: string }
export interface PurchaseOrder { id: string; supplierId: string; sku: string; qty: number; unitPrice: number; eta: string; originalEta: string; status: string; express: boolean; note: string; releasedAt?: string }
export interface Customer { id: string; name: string; tier: string; penaltyPctPerWeekLate: number; contact: string }
export interface SalesOrder { id: string; customerId: string; product: ProductId; qty: number; fabric: string; promisedDelivery: string; communicatedDelivery: string | null; status: string }
export interface ProductionOrder { id: string; salesOrderId: string; factory: FactoryId; product: ProductId; fabric: string; qty: number; priority: number; dueDate: string; status: string }
export interface Ticket { id: string; machineId: string; status: string; requiredPart?: string; [k: string]: unknown }
export interface Campaign { id: string; name: string; from: string; to: string; status: string; dailyBudgetPct: number; note: string }

export interface World {
  factories: Record<FactoryId, { id: FactoryId; name: string }>;
  machines: Machine[];
  workers: Worker[];
  temp: Array<{ factory: FactoryId; from: string; to: string; count: number; [k: string]: unknown }>;
  overtime: Array<{ factory: FactoryId; from: string; to: string; [k: string]: unknown }>;
  suppliers: Supplier[];
  lots: Lot[];
  purchaseOrders: PurchaseOrder[];
  customers: Customer[];
  salesOrders: SalesOrder[];
  productionOrders: ProductionOrder[];
  tickets: Ticket[];
  campaigns: Campaign[];
  incidents: unknown[];
  customerNotices: unknown[];
  log: unknown[];
  costEur: number;
  events: string[];
}

export interface Sequences { po: number; ticket: number; inc: number; prd: number }

const salesOrder = ([id, customerId, product, qty, fabric, promised]: SalesRow): SalesOrder => ({ id, customerId, product, qty, fabric, promisedDelivery: promised, communicatedDelivery: null, status: 'confirmed' });

export function productionOrder(s: SalesOrder, factory: FactoryId, seq: Sequences): ProductionOrder {
  return { id: `PRD-${seq.prd++}`, salesOrderId: s.id, factory, product: s.product, fabric: s.fabric, qty: s.qty, priority: 5, dueDate: addDays(s.promisedDelivery, -SHIPPING_DAYS), status: 'planned' };
}

/** The undisturbed baseline (the mock's /reset). Returns the world and the id sequences it continues with. */
export function freshWorld(): { world: World; seq: Sequences } {
  const seq: Sequences = { po: 4430, ticket: 1, inc: 1, prd: 4200 };
  const w: World = {
    factories: {
      'F-NORTH': { id: 'F-NORTH', name: 'Werk Nord (Hamburg)' },
      'F-SOUTH': { id: 'F-SOUTH', name: 'Werk Süd (Stuttgart)' },
    },
    machines: (['N', 'S'] as const).flatMap((p) =>
      (
        [
          ['CUT-1', 'CNC frame cutter', 60],
          ['UPH-1', 'Upholstery line', 50],
          ['ASM-1', 'Assembly line', 48],
        ] as const
      ).map(([n, name, rate]) => ({ id: `${p}-${n}`, factory: (p === 'N' ? 'F-NORTH' : 'F-SOUTH') as FactoryId, name, ratePerDay: rate, status: 'running', downSince: null, note: '' })),
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
    salesOrders: SALES.map(salesOrder),
    productionOrders: [],
    tickets: [],
    campaigns: [{ id: 'CMP-HERBST', name: 'Herbstzauber (autumn sale, online ads)', from: '2026-10-01', to: '2026-10-31', status: 'active', dailyBudgetPct: 100, note: '' }],
    incidents: [],
    customerNotices: [],
    log: [],
    costEur: 0,
    events: [],
  };
  // one production order per sales order; alternate factories
  w.productionOrders = w.salesOrders.map((s, i) => productionOrder(s, i % 2 === 0 ? 'F-NORTH' : 'F-SOUTH', seq));
  return { world: w, seq };
}
