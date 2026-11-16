// GENERATED from ontology sofa@0.1.0 (0d44abb6df1c) — do not edit; run node scripts/liquid/ontology-build.mjs

import type { Factory, Machine, Worker, Absence, OvertimeShift, TempWorkerAssignment, Material, Bom, Supplier, InventoryItem, PurchaseOrder, ProductionOrder, MaintenanceTicket, Incident, Customer, SalesOrder, CustomerNotice, Campaign, DemandSignal, GetOverviewInput, GetKpiInput, SimulateChangeInput, ListMachinesInput, ListWorkersInput, GetCapacityInput, ListProductionOrdersInput, GetInventoryInput, GetMaterialProjectionInput, ListPurchaseOrdersInput, ListSuppliersInput, GetBomInput, ListMaintenanceTicketsInput, CreatePurchaseOrderInput, CancelPurchaseOrderInput, CreateMaintenanceTicketInput, UpdateProductionOrderInput, CreateProductionOrderInput, RequestOvertimeInput, RequestTempWorkersInput, WriteOffStockInput, ReleaseStockInput, FileIncidentReportInput, ListCustomersInput, ListOrdersInput, GetOrderInput, ListCampaignsInput, GetDemandTrendInput, SendCustomerNoticeInput, UpdateDeliveryDateInput, UpdateCampaignInput } from './types.js';

export interface ClientOptions {
  /** Base URL of the ontology server REST API, e.g. https://onto.example/api */
  baseUrl: string;
  /** OIDC access token provider (the app registry issues the client, M9). */
  token: () => string | Promise<string>;
  fetch?: typeof fetch;
}

export class OntologyError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

export function createClient(o: ClientOptions) {
  const f = o.fetch ?? fetch;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await f(`${o.baseUrl.replace(/\/$/, '')}${path}`, { method, headers: { authorization: `Bearer ${await o.token()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new OntologyError(res.status, (json as { error?: string } | undefined)?.error ?? res.statusText, json);
    return json as T;
  };
  const objects = <T>(cls: string) => ({
    list: (params: Record<string, string> = {}) => call<T[]>('GET', `/objects/${cls}?${new URLSearchParams(params)}`),
    get: (id: string) => call<T>('GET', `/objects/${cls}/${encodeURIComponent(id)}`),
  });
  return {
    ontology: {"name":"sofa","version":"0.1.0","hash":"0d44abb6df1cac5d3466736d0307cd2aa77b0b89381bae727e9b60cbc5b9b9d7"},
    objects: {
      factory: objects<Factory>("Factory"),
      machine: objects<Machine>("Machine"),
      worker: objects<Worker>("Worker"),
      absence: objects<Absence>("Absence"),
      overtimeShift: objects<OvertimeShift>("OvertimeShift"),
      tempWorkerAssignment: objects<TempWorkerAssignment>("TempWorkerAssignment"),
      material: objects<Material>("Material"),
      bom: objects<Bom>("Bom"),
      supplier: objects<Supplier>("Supplier"),
      inventoryItem: objects<InventoryItem>("InventoryItem"),
      purchaseOrder: objects<PurchaseOrder>("PurchaseOrder"),
      productionOrder: objects<ProductionOrder>("ProductionOrder"),
      maintenanceTicket: objects<MaintenanceTicket>("MaintenanceTicket"),
      incident: objects<Incident>("Incident"),
      customer: objects<Customer>("Customer"),
      salesOrder: objects<SalesOrder>("SalesOrder"),
      customerNotice: objects<CustomerNotice>("CustomerNotice"),
      campaign: objects<Campaign>("Campaign"),
      demandSignal: objects<DemandSignal>("DemandSignal"),
    },
    actions: {
      /** ERP dashboard as of the simulation date: factories (capacity, machines, staff), alerts from the shop floor and warehouse, and business KPIs (late orders, materi… */
      getOverview: (input: GetOverviewInput) => call<unknown>('POST', '/actions/get_overview', input),
      /** Business KPI of the plan right now: orders expected late, sofas late, unplanned orders, orders late without customer notice, material shortages, cost of measure… */
      getKpi: (input: GetKpiInput) => call<unknown>('POST', '/actions/get_kpi', input),
      /** WHAT-IF, read-only. Applies one change, or a SEQUENCE of changes (parameter "changes", applied in order), of the ERP change tools (create_purchase_order, update… */
      simulateChange: (input: SimulateChangeInput) => call<unknown>('POST', '/actions/simulate_change', input),
      /** Machines per factory with status, notes and the open maintenance ticket. */
      listMachines: (input: ListMachinesInput) => call<unknown>('POST', '/actions/list_machines', input),
      /** Production workers per factory with planned absences. */
      listWorkers: (input: ListWorkersInput) => call<unknown>('POST', '/actions/list_workers', input),
      /** Daily production capacity (sofas/day) of a factory for the next workdays, with the reason. */
      getCapacity: (input: GetCapacityInput) => call<unknown>('POST', '/actions/get_capacity', input),
      /** Production orders with factory, priority, quantity, due date and the simulated completion date. Filter by factory or show only orders that will miss their deliv… */
      listProductionOrders: (input: ListProductionOrdersInput) => call<unknown>('POST', '/actions/list_production_orders', input),
      /** Warehouse stock by lot (status ok, quarantined or written_off) with the total usable quantity per SKU. */
      getInventory: (input: GetInventoryInput) => call<unknown>('POST', '/actions/get_inventory', input),
      /** Projected stock of a SKU over the coming workdays (consumption by the production plan, arrival of open purchase orders) and the first day production is held bac… */
      getMaterialProjection: (input: GetMaterialProjectionInput) => call<unknown>('POST', '/actions/get_material_projection', input),
      /** Purchase orders with supplier, quantity, delivery date and status (open, delayed, cancelled). */
      listPurchaseOrders: (input: ListPurchaseOrdersInput) => call<unknown>('POST', '/actions/list_purchase_orders', input),
      /** Suppliers with the SKUs they supply, lead time, price, order size limits, express option and current status/notice. */
      listSuppliers: (input: ListSuppliersInput) => call<unknown>('POST', '/actions/list_suppliers', input),
      /** Bill of materials of a sofa model (beams, fabric metres, foam blocks per sofa). */
      getBom: (input: GetBomInput) => call<unknown>('POST', '/actions/get_bom', input),
      /** Maintenance tickets with status and planned repair date. */
      listMaintenanceTickets: (input: ListMaintenanceTicketsInput) => call<unknown>('POST', '/actions/list_maintenance_tickets', input),
      /** WRITE. Place a purchase order with a supplier. Returns the delivery date. Fails if the supplier cannot deliver or the quantity is outside its limits. */
      createPurchaseOrder: (input: CreatePurchaseOrderInput) => call<unknown>('POST', '/actions/create_purchase_order', input),
      /** WRITE. Cancel an open or delayed purchase order. */
      cancelPurchaseOrder: (input: CancelPurchaseOrderInput) => call<unknown>('POST', '/actions/cancel_purchase_order', input),
      /** WRITE. Open a maintenance ticket for a machine and book the external technician. The repair starts when the required spare part has been delivered (a purchase o… */
      createMaintenanceTicket: (input: CreateMaintenanceTicketInput) => call<unknown>('POST', '/actions/create_maintenance_ticket', input),
      /** WRITE. Move a production order to the other factory and/or change its priority (1 = most urgent … 9). The simulation re-sequences both factory queues. */
      updateProductionOrder: (input: UpdateProductionOrderInput) => call<unknown>('POST', '/actions/update_production_order', input),
      /** WRITE. Create the production order for a confirmed, unplanned sales order and put it into a factory queue. */
      createProductionOrder: (input: CreateProductionOrderInput) => call<unknown>('POST', '/actions/create_production_order', input),
      /** WRITE. Book overtime in a factory for a date range: +25% output of the available staff (max 48 sofas/day). Costs EUR 1,400 per factory and day. */
      requestOvertime: (input: RequestOvertimeInput) => call<unknown>('POST', '/actions/request_overtime', input),
      /** WRITE. Book temporary workers from the agency for a factory and date range. Each delivers 15 sofas/day. They start 3 workdays after the request. Costs EUR 260 p… */
      requestTempWorkers: (input: RequestTempWorkersInput) => call<unknown>('POST', '/actions/request_temp_workers', input),
      /** WRITE. Write off a quantity of a warehouse lot (damaged goods). Cannot be undone. */
      writeOffStock: (input: WriteOffStockInput) => call<unknown>('POST', '/actions/write_off_stock', input),
      /** WRITE. Release a quarantined lot (or part of it) for production after inspection. */
      releaseStock: (input: ReleaseStockInput) => call<unknown>('POST', '/actions/release_stock', input),
      /** WRITE. File an incident report for the insurance (storm, fire, theft …). Returns the claim number. */
      fileIncidentReport: (input: FileIncidentReportInput) => call<unknown>('POST', '/actions/file_incident_report', input),
      /** Customers with tier, late-delivery penalty and contact address. */
      listCustomers: (input: ListCustomersInput) => call<unknown>('POST', '/actions/list_customers', input),
      /** Sales orders with promised delivery date, simulated expected delivery date and days late. Filter by customer or show only orders that are expected late or not y… */
      listOrders: (input: ListOrdersInput) => call<unknown>('POST', '/actions/list_orders', input),
      /** One sales order in detail, including its production order. */
      getOrder: (input: GetOrderInput) => call<unknown>('POST', '/actions/get_order', input),
      /** Marketing campaigns with period, status, budget level and observed effect on order intake. */
      listCampaigns: (input: ListCampaignsInput) => call<unknown>('POST', '/actions/list_campaigns', input),
      /** Weekly sofas ordered versus the plan (order intake trend), including orders that are not planned for production yet. */
      getDemandTrend: (input: GetDemandTrendInput) => call<unknown>('POST', '/actions/get_demand_trend', input),
      /** WRITE. Send a notice (e-mail) to a customer about their orders, for example a delivery delay. The mail is recorded, not delivered. */
      sendCustomerNotice: (input: SendCustomerNoticeInput) => call<unknown>('POST', '/actions/send_customer_notice', input),
      /** WRITE. Record a new delivery date that was communicated to the customer for a sales order. */
      updateDeliveryDate: (input: UpdateDeliveryDateInput) => call<unknown>('POST', '/actions/update_delivery_date', input),
      /** WRITE. Change a campaign: throttle the daily ad budget (percent of the normal budget, 0-100) or pause/resume it. Lower budget reduces new order intake after a f… */
      updateCampaign: (input: UpdateCampaignInput) => call<unknown>('POST', '/actions/update_campaign', input),
    },
  };
}

export type OntologyClient = ReturnType<typeof createClient>;
