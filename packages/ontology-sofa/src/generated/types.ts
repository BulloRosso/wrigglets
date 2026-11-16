// GENERATED from ontology sofa@0.1.0 (47c5052c5079) — do not edit; run node scripts/liquid/ontology-build.mjs

import { z } from 'zod';

export const ONTOLOGY = { name: "sofa", version: "0.1.0", hash: "47c5052c50791e50d7bd89bc9c72e58bf8b1242f42044d59d40ceb4fe67c69cd" } as const;

export const MachineStatus = z.enum(["running","down"]);
export type MachineStatus = z.infer<typeof MachineStatus>;

export const SupplierStatus = z.enum(["ok","cannot_deliver"]);
export type SupplierStatus = z.infer<typeof SupplierStatus>;

export const SupplierRating = z.enum(["A","B","C"]);
export type SupplierRating = z.infer<typeof SupplierRating>;

export const LotStatus = z.enum(["ok","quarantined"]);
export type LotStatus = z.infer<typeof LotStatus>;

export const PurchaseOrderStatus = z.enum(["open","delayed","cancelled"]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatus>;

export const ProductionOrderStatus = z.enum(["planned"]);
export type ProductionOrderStatus = z.infer<typeof ProductionOrderStatus>;

export const MaintenanceTicketStatus = z.enum(["open","closed"]);
export type MaintenanceTicketStatus = z.infer<typeof MaintenanceTicketStatus>;

export const CustomerTier = z.enum(["A","B"]);
export type CustomerTier = z.infer<typeof CustomerTier>;

export const SalesOrderStatus = z.enum(["confirmed","confirmed_unplanned"]);
export type SalesOrderStatus = z.infer<typeof SalesOrderStatus>;

export const CampaignStatus = z.enum(["active","paused"]);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

export const ProductCode = z.enum(["LUND","OSLO","BERGEN"]);
export type ProductCode = z.infer<typeof ProductCode>;

export const DemandSource = z.enum(["plan","campaign"]);
export type DemandSource = z.infer<typeof DemandSource>;

/** A plant that produces sofas. (criticality: business_critical, data: internal, owner: head-of-production) */
export const Factory = z.object({
  id: z.string().describe("e.g. F-NORTH"),
  name: z.string(),
});
export type Factory = z.infer<typeof Factory>;

/** A production machine; when one is down, its factory produces nothing. (criticality: business_critical, data: internal, owner: head-of-production) */
export const Machine = z.object({
  id: z.string().describe("e.g. N-CUT-1"),
  factory: z.string().min(1),
  name: z.string(),
  rate_per_day: z.number().int().describe("Sofas per day at full staffing"),
  status: MachineStatus,
  down_since: z.iso.date().nullish(),
  note: z.string().nullish(),
});
export type Machine = z.infer<typeof Machine>;

/** A regular worker of a factory. (criticality: normal, data: confidential, owner: head-of-production) */
export const Worker = z.object({
  id: z.string(),
  name: z.string(),
  factory: z.string().min(1),
});
export type Worker = z.infer<typeof Worker>;

/** A period in which a worker is absent (sick leave, vacation). (criticality: normal, data: confidential, owner: head-of-production) */
export const Absence = z.object({
  id: z.string().describe("worker id + start date"),
  worker: z.string().min(1),
  date_from: z.iso.date(),
  date_to: z.iso.date(),
  reason: z.string().nullish(),
});
export type Absence = z.infer<typeof Absence>;

/** Approved overtime in a factory (capacity x1.25). (criticality: normal, data: internal, owner: head-of-production) */
export const OvertimeShift = z.object({
  id: z.string(),
  factory: z.string().min(1),
  date_from: z.iso.date(),
  date_to: z.iso.date(),
});
export type OvertimeShift = z.infer<typeof OvertimeShift>;

/** Temporary workers booked for a factory. (criticality: normal, data: internal, owner: head-of-production) */
export const TempWorkerAssignment = z.object({
  id: z.string(),
  factory: z.string().min(1),
  count: z.number().int(),
  date_from: z.iso.date(),
  date_to: z.iso.date(),
});
export type TempWorkerAssignment = z.infer<typeof TempWorkerAssignment>;

/** A purchased material or spare part, identified by SKU. (criticality: normal, data: internal, owner: head-of-logistics) */
export const Material = z.object({
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  unit_cost: z.number(),
});
export type Material = z.infer<typeof Material>;

/** Bill of materials of a sofa model. (criticality: normal, data: internal, owner: head-of-production) */
export const Bom = z.object({
  product: ProductCode,
  product_name: z.string(),
  beams: z.number().int(),
  fabric_m: z.number(),
  foam: z.number().int(),
});
export type Bom = z.infer<typeof Bom>;

/** A supplier of materials or spare parts. (criticality: business_critical, data: confidential, owner: head-of-logistics) */
export const Supplier = z.object({
  id: z.string().describe("e.g. S-NORDHOLZ"),
  name: z.string(),
  skus: z.array(z.string().min(1)),
  lead_workdays: z.number().int(),
  unit_price: z.number(),
  min_qty: z.number().int(),
  max_qty: z.number().int(),
  express_lead_workdays: z.number().int().nullish(),
  express_surcharge_per_unit: z.number().nullish(),
  rating: SupplierRating,
  status: SupplierStatus,
  notice: z.string().nullish(),
});
export type Supplier = z.infer<typeof Supplier>;

/** A lot of material in the warehouse. (criticality: business_critical, data: internal, owner: head-of-logistics) */
export const InventoryItem = z.object({
  lot_id: z.string(),
  sku: z.string().min(1),
  qty: z.number(),
  location: z.string().nullish(),
  status: LotStatus,
  note: z.string().nullish(),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

/** An order to a supplier; commits money. (criticality: payment_critical, data: confidential, owner: head-of-logistics) */
export const PurchaseOrder = z.object({
  id: z.string().describe("e.g. PO-4411"),
  supplier: z.string().min(1),
  sku: z.string().min(1),
  qty: z.number(),
  unit_price: z.number(),
  eta: z.iso.date(),
  original_eta: z.iso.date().nullish(),
  status: PurchaseOrderStatus,
  express: z.boolean().nullish(),
  note: z.string().nullish(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

/** An order to produce the sofas of a sales order in a factory. (criticality: business_critical, data: internal, owner: head-of-production) */
export const ProductionOrder = z.object({
  id: z.string(),
  sales_order: z.string().min(1),
  factory: z.string().min(1),
  product: z.string().min(1),
  fabric: z.string().min(1),
  qty: z.number().int(),
  priority: z.number().int().describe("1 = most urgent"),
  due_date: z.iso.date(),
  status: ProductionOrderStatus,
});
export type ProductionOrder = z.infer<typeof ProductionOrder>;

/** A repair order for a machine. (criticality: business_critical, data: internal, owner: head-of-production) */
export const MaintenanceTicket = z.object({
  id: z.string(),
  machine: z.string().min(1),
  status: MaintenanceTicketStatus,
  required_part: z.string().min(1).nullish(),
  description: z.string().nullish(),
});
export type MaintenanceTicket = z.infer<typeof MaintenanceTicket>;

/** An incident report for insurance (e.g. storm damage). (criticality: normal, data: internal, owner: head-of-logistics) */
export const Incident = z.object({
  id: z.string(),
  type: z.string(),
  description: z.string(),
  estimated_loss_eur: z.number(),
});
export type Incident = z.infer<typeof Incident>;

/** A B2B customer (retailer). (criticality: business_critical, data: confidential, owner: head-of-sales) */
export const Customer = z.object({
  id: z.string().describe("e.g. C-01"),
  name: z.string(),
  tier: CustomerTier,
  penalty_pct_per_week_late: z.number(),
  contact: z.string().describe("E-mail address"),
});
export type Customer = z.infer<typeof Customer>;

/** A customer order with a promised delivery date. (criticality: business_critical, data: confidential, owner: head-of-sales) */
export const SalesOrder = z.object({
  id: z.string().describe("e.g. SO-2101"),
  customer: z.string().min(1),
  product: z.string().min(1),
  qty: z.number().int(),
  fabric: z.string().min(1),
  promised_delivery: z.iso.date(),
  communicated_delivery: z.iso.date().nullish(),
  status: SalesOrderStatus,
});
export type SalesOrder = z.infer<typeof SalesOrder>;

/** A message sent to a customer about their orders (recorded, not delivered). (criticality: normal, data: confidential, owner: head-of-sales) */
export const CustomerNotice = z.object({
  id: z.string(),
  customer: z.string().min(1),
  orders: z.array(z.string().min(1)),
  subject: z.string(),
  body: z.string(),
});
export type CustomerNotice = z.infer<typeof CustomerNotice>;

/** A marketing campaign that drives order intake. (criticality: normal, data: internal, owner: head-of-sales) */
export const Campaign = z.object({
  id: z.string(),
  name: z.string(),
  date_from: z.iso.date(),
  date_to: z.iso.date(),
  status: CampaignStatus,
  daily_budget_pct: z.number(),
  note: z.string().nullish(),
});
export type Campaign = z.infer<typeof Campaign>;

/** Planned order intake per sales order (basis of the production plan and the demand trend). (criticality: normal, data: internal, owner: head-of-sales) */
export const DemandSignal = z.object({
  sales_order_id: z.string(),
  customer: z.string().min(1),
  product: ProductCode,
  qty: z.number().int(),
  promised_delivery: z.iso.date(),
  source: DemandSource,
});
export type DemandSignal = z.infer<typeof DemandSignal>;

export const CLASSES = { Factory, Machine, Worker, Absence, OvertimeShift, TempWorkerAssignment, Material, Bom, Supplier, InventoryItem, PurchaseOrder, ProductionOrder, MaintenanceTicket, Incident, Customer, SalesOrder, CustomerNotice, Campaign, DemandSignal } as const;
export type ClassName = keyof typeof CLASSES;

/** Input of get_overview (query, read-only) */
export const GetOverviewInput = z.object({
});
export type GetOverviewInput = z.infer<typeof GetOverviewInput>;

/** Input of get_kpi (query, read-only) */
export const GetKpiInput = z.object({
});
export type GetKpiInput = z.infer<typeof GetKpiInput>;

/** Input of simulate_change (query, read-only) */
export const SimulateChangeInput = z.object({
  tool: z.string().describe("Name of an ERP change tool (single change)").optional(),
  arguments: z.unknown().describe("Arguments of that tool (single change)").optional(),
  changes: z.array(z.unknown()).describe("A sequence of changes to apply together").optional(),
});
export type SimulateChangeInput = z.infer<typeof SimulateChangeInput>;

/** Input of list_machines (query, read-only) */
export const ListMachinesInput = z.object({
  factory: z.enum(["F-NORTH","F-SOUTH"]).describe("Factory id: F-NORTH or F-SOUTH").optional(),
});
export type ListMachinesInput = z.infer<typeof ListMachinesInput>;

/** Input of list_workers (query, read-only) */
export const ListWorkersInput = z.object({
  factory: z.enum(["F-NORTH","F-SOUTH"]).describe("Factory id: F-NORTH or F-SOUTH").optional(),
});
export type ListWorkersInput = z.infer<typeof ListWorkersInput>;

/** Input of get_capacity (query, read-only) */
export const GetCapacityInput = z.object({
  factory: z.enum(["F-NORTH","F-SOUTH"]).describe("Factory id: F-NORTH or F-SOUTH"),
  days: z.number().describe("Number of workdays, default 15").optional(),
});
export type GetCapacityInput = z.infer<typeof GetCapacityInput>;

/** Input of list_production_orders (query, read-only) */
export const ListProductionOrdersInput = z.object({
  factory: z.enum(["F-NORTH","F-SOUTH"]).describe("Factory id: F-NORTH or F-SOUTH").optional(),
  lateOnly: z.boolean().describe("Only orders expected to deliver after the promised date").optional(),
});
export type ListProductionOrdersInput = z.infer<typeof ListProductionOrdersInput>;

/** Input of get_inventory (query, read-only) */
export const GetInventoryInput = z.object({
  sku: z.string().min(1).describe("Optional SKU filter, e.g. BEAM-PINE-80").optional(),
});
export type GetInventoryInput = z.infer<typeof GetInventoryInput>;

/** Input of get_material_projection (query, read-only) */
export const GetMaterialProjectionInput = z.object({
  sku: z.string().min(1).describe("SKU, e.g. BEAM-PINE-80 or FAB-OAT-01"),
});
export type GetMaterialProjectionInput = z.infer<typeof GetMaterialProjectionInput>;

/** Input of list_purchase_orders (query, read-only) */
export const ListPurchaseOrdersInput = z.object({
  sku: z.string().min(1).describe("Optional SKU filter").optional(),
});
export type ListPurchaseOrdersInput = z.infer<typeof ListPurchaseOrdersInput>;

/** Input of list_suppliers (query, read-only) */
export const ListSuppliersInput = z.object({
  sku: z.string().min(1).describe("Optional SKU filter").optional(),
});
export type ListSuppliersInput = z.infer<typeof ListSuppliersInput>;

/** Input of get_bom (query, read-only) */
export const GetBomInput = z.object({
  product: z.string().describe("LUND, OSLO or BERGEN").optional(),
});
export type GetBomInput = z.infer<typeof GetBomInput>;

/** Input of list_maintenance_tickets (query, read-only) */
export const ListMaintenanceTicketsInput = z.object({
});
export type ListMaintenanceTicketsInput = z.infer<typeof ListMaintenanceTicketsInput>;

/** Input of create_purchase_order (create) */
export const CreatePurchaseOrderInput = z.object({
  supplierId: z.string().min(1).describe("Supplier id, e.g. S-BALTIC"),
  sku: z.string().min(1).describe("SKU"),
  quantity: z.number().describe("Quantity"),
  express: z.boolean().describe("Express delivery if the supplier offers it (surcharge per unit)").optional(),
  note: z.string().describe("Reason / reference").optional(),
});
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderInput>;

/** Input of cancel_purchase_order (update, destructive) */
export const CancelPurchaseOrderInput = z.object({
  poId: z.string().min(1).describe("Purchase order id"),
  reason: z.string().describe("Reason"),
});
export type CancelPurchaseOrderInput = z.infer<typeof CancelPurchaseOrderInput>;

/** Input of create_maintenance_ticket (create) */
export const CreateMaintenanceTicketInput = z.object({
  machineId: z.string().min(1).describe("Machine id, e.g. N-CUT-1"),
  description: z.string().describe("Fault description"),
  requiredPart: z.string().min(1).describe("SKU of the spare part, if known").optional(),
});
export type CreateMaintenanceTicketInput = z.infer<typeof CreateMaintenanceTicketInput>;

/** Input of update_production_order (update) */
export const UpdateProductionOrderInput = z.object({
  orderId: z.string().min(1).describe("Production order id, e.g. PRD-4204"),
  factory: z.enum(["F-NORTH","F-SOUTH"]).describe("Factory id: F-NORTH or F-SOUTH").optional(),
  priority: z.number().describe("1-9").optional(),
});
export type UpdateProductionOrderInput = z.infer<typeof UpdateProductionOrderInput>;

/** Input of create_production_order (create) */
export const CreateProductionOrderInput = z.object({
  salesOrderId: z.string().min(1).describe("Sales order id, e.g. SO-2301"),
  factory: z.enum(["F-NORTH","F-SOUTH"]).describe("Factory id: F-NORTH or F-SOUTH"),
  priority: z.number().describe("1-9, default 5").optional(),
});
export type CreateProductionOrderInput = z.infer<typeof CreateProductionOrderInput>;

/** Input of request_overtime (create) */
export const RequestOvertimeInput = z.object({
  factory: z.enum(["F-NORTH","F-SOUTH"]).describe("Factory id: F-NORTH or F-SOUTH"),
  from: z.iso.date().describe("First day, YYYY-MM-DD"),
  to: z.iso.date().describe("Last day, YYYY-MM-DD"),
});
export type RequestOvertimeInput = z.infer<typeof RequestOvertimeInput>;

/** Input of request_temp_workers (create) */
export const RequestTempWorkersInput = z.object({
  factory: z.enum(["F-NORTH","F-SOUTH"]).describe("Factory id: F-NORTH or F-SOUTH"),
  count: z.number().describe("Number of workers (1-4)"),
  from: z.iso.date().describe("First day, YYYY-MM-DD"),
  to: z.iso.date().describe("Last day, YYYY-MM-DD"),
});
export type RequestTempWorkersInput = z.infer<typeof RequestTempWorkersInput>;

/** Input of write_off_stock (update, destructive) */
export const WriteOffStockInput = z.object({
  lotId: z.string().min(1).describe("Lot id, e.g. L-OAT-231"),
  quantity: z.number().describe("Quantity to write off"),
  reason: z.string().describe("Reason"),
});
export type WriteOffStockInput = z.infer<typeof WriteOffStockInput>;

/** Input of release_stock (update) */
export const ReleaseStockInput = z.object({
  lotId: z.string().min(1).describe("Lot id"),
  quantity: z.number().describe("Quantity to release"),
  note: z.string().describe("Inspection reference").optional(),
});
export type ReleaseStockInput = z.infer<typeof ReleaseStockInput>;

/** Input of file_incident_report (create) */
export const FileIncidentReportInput = z.object({
  type: z.string().describe("Incident type, e.g. storm_damage"),
  description: z.string().describe("What happened"),
  estimatedLossEur: z.number().describe("Estimated loss in EUR"),
});
export type FileIncidentReportInput = z.infer<typeof FileIncidentReportInput>;

/** Input of list_customers (query, read-only) */
export const ListCustomersInput = z.object({
});
export type ListCustomersInput = z.infer<typeof ListCustomersInput>;

/** Input of list_orders (query, read-only) */
export const ListOrdersInput = z.object({
  customerId: z.string().min(1).describe("Customer id, e.g. C-01").optional(),
  riskOnly: z.boolean().describe("Only orders expected late, or not yet planned for production").optional(),
});
export type ListOrdersInput = z.infer<typeof ListOrdersInput>;

/** Input of get_order (query, read-only) */
export const GetOrderInput = z.object({
  orderId: z.string().min(1).describe("Sales order id"),
});
export type GetOrderInput = z.infer<typeof GetOrderInput>;

/** Input of list_campaigns (query, read-only) */
export const ListCampaignsInput = z.object({
});
export type ListCampaignsInput = z.infer<typeof ListCampaignsInput>;

/** Input of get_demand_trend (query, read-only) */
export const GetDemandTrendInput = z.object({
});
export type GetDemandTrendInput = z.infer<typeof GetDemandTrendInput>;

/** Input of send_customer_notice (create) */
export const SendCustomerNoticeInput = z.object({
  customerId: z.string().min(1).describe("Customer id"),
  orderIds: z.array(z.string().min(1)).describe("Sales orders concerned"),
  subject: z.string().describe("Subject"),
  body: z.string().describe("Message text"),
});
export type SendCustomerNoticeInput = z.infer<typeof SendCustomerNoticeInput>;

/** Input of update_delivery_date (update) */
export const UpdateDeliveryDateInput = z.object({
  orderId: z.string().min(1).describe("Sales order id"),
  newDate: z.iso.date().describe("YYYY-MM-DD"),
  reason: z.string().describe("Reason given to the customer"),
});
export type UpdateDeliveryDateInput = z.infer<typeof UpdateDeliveryDateInput>;

/** Input of update_campaign (update) */
export const UpdateCampaignInput = z.object({
  campaignId: z.string().min(1).describe("Campaign id"),
  dailyBudgetPct: z.number().describe("0-100").optional(),
  status: CampaignStatus.describe("active or paused").optional(),
  reason: z.string().describe("Reason").optional(),
});
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignInput>;

export const ACTION_INPUTS = {
  get_overview: GetOverviewInput,
  get_kpi: GetKpiInput,
  simulate_change: SimulateChangeInput,
  list_machines: ListMachinesInput,
  list_workers: ListWorkersInput,
  get_capacity: GetCapacityInput,
  list_production_orders: ListProductionOrdersInput,
  get_inventory: GetInventoryInput,
  get_material_projection: GetMaterialProjectionInput,
  list_purchase_orders: ListPurchaseOrdersInput,
  list_suppliers: ListSuppliersInput,
  get_bom: GetBomInput,
  list_maintenance_tickets: ListMaintenanceTicketsInput,
  create_purchase_order: CreatePurchaseOrderInput,
  cancel_purchase_order: CancelPurchaseOrderInput,
  create_maintenance_ticket: CreateMaintenanceTicketInput,
  update_production_order: UpdateProductionOrderInput,
  create_production_order: CreateProductionOrderInput,
  request_overtime: RequestOvertimeInput,
  request_temp_workers: RequestTempWorkersInput,
  write_off_stock: WriteOffStockInput,
  release_stock: ReleaseStockInput,
  file_incident_report: FileIncidentReportInput,
  list_customers: ListCustomersInput,
  list_orders: ListOrdersInput,
  get_order: GetOrderInput,
  list_campaigns: ListCampaignsInput,
  get_demand_trend: GetDemandTrendInput,
  send_customer_notice: SendCustomerNoticeInput,
  update_delivery_date: UpdateDeliveryDateInput,
  update_campaign: UpdateCampaignInput,
} as const;
export type ActionName = keyof typeof ACTION_INPUTS;
