-- GENERATED from ontology sofa@0.1.0 (0d44abb6df1c) — do not edit; run node scripts/liquid/ontology-build.mjs

CREATE SCHEMA IF NOT EXISTS projection;

-- Factory: A plant that produces sofas. (identifier id)
CREATE TABLE IF NOT EXISTS projection.factory (
  id text PRIMARY KEY,
  name text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Machine: A production machine; when one is down, its factory produces nothing. (identifier id)
CREATE TABLE IF NOT EXISTS projection.machine (
  id text PRIMARY KEY,
  factory text NOT NULL,
  name text NOT NULL,
  rate_per_day bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'down')),
  down_since date,
  note text,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Worker: A regular worker of a factory. (identifier id)
CREATE TABLE IF NOT EXISTS projection.worker (
  id text PRIMARY KEY,
  name text NOT NULL,
  factory text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Absence: A period in which a worker is absent (sick leave, vacation). (identifier id)
CREATE TABLE IF NOT EXISTS projection.absence (
  id text PRIMARY KEY,
  worker text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  reason text,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- OvertimeShift: Approved overtime in a factory (capacity x1.25). (identifier id)
CREATE TABLE IF NOT EXISTS projection.overtime_shift (
  id text PRIMARY KEY,
  factory text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- TempWorkerAssignment: Temporary workers booked for a factory. (identifier id)
CREATE TABLE IF NOT EXISTS projection.temp_worker_assignment (
  id text PRIMARY KEY,
  factory text NOT NULL,
  count bigint NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Material: A purchased material or spare part, identified by SKU. (identifier sku)
CREATE TABLE IF NOT EXISTS projection.material (
  sku text PRIMARY KEY,
  name text NOT NULL,
  unit text NOT NULL,
  unit_cost double precision NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Bom: Bill of materials of a sofa model. (identifier product)
CREATE TABLE IF NOT EXISTS projection.bom (
  product text PRIMARY KEY CHECK (product IN ('LUND', 'OSLO', 'BERGEN')),
  product_name text NOT NULL,
  beams bigint NOT NULL,
  fabric_m double precision NOT NULL,
  foam bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Supplier: A supplier of materials or spare parts. (identifier id)
CREATE TABLE IF NOT EXISTS projection.supplier (
  id text PRIMARY KEY,
  name text NOT NULL,
  skus text[] NOT NULL,
  lead_workdays bigint NOT NULL,
  unit_price double precision NOT NULL,
  min_qty bigint NOT NULL,
  max_qty bigint NOT NULL,
  express_lead_workdays bigint,
  express_surcharge_per_unit double precision,
  rating text NOT NULL CHECK (rating IN ('A', 'B', 'C')),
  status text NOT NULL CHECK (status IN ('ok', 'cannot_deliver')),
  notice text,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- InventoryItem: A lot of material in the warehouse. (identifier lot_id)
CREATE TABLE IF NOT EXISTS projection.inventory_item (
  lot_id text PRIMARY KEY,
  sku text NOT NULL,
  qty double precision NOT NULL,
  location text,
  status text NOT NULL CHECK (status IN ('ok', 'quarantined')),
  note text,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- PurchaseOrder: An order to a supplier; commits money. (identifier id)
CREATE TABLE IF NOT EXISTS projection.purchase_order (
  id text PRIMARY KEY,
  supplier text NOT NULL,
  sku text NOT NULL,
  qty double precision NOT NULL,
  unit_price double precision NOT NULL,
  eta date NOT NULL,
  original_eta date,
  status text NOT NULL CHECK (status IN ('open', 'delayed', 'cancelled')),
  express boolean,
  note text,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- ProductionOrder: An order to produce the sofas of a sales order in a factory. (identifier id)
CREATE TABLE IF NOT EXISTS projection.production_order (
  id text PRIMARY KEY,
  sales_order text NOT NULL,
  factory text NOT NULL,
  product text NOT NULL,
  fabric text NOT NULL,
  qty bigint NOT NULL,
  priority bigint NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('planned')),
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- MaintenanceTicket: A repair order for a machine. (identifier id)
CREATE TABLE IF NOT EXISTS projection.maintenance_ticket (
  id text PRIMARY KEY,
  machine text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  required_part text,
  description text,
  technician_booked date,
  opened_at date,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Incident: An incident report for insurance (e.g. storm damage). (identifier id)
CREATE TABLE IF NOT EXISTS projection.incident (
  id text PRIMARY KEY,
  type text NOT NULL,
  description text NOT NULL,
  estimated_loss_eur double precision NOT NULL,
  claim text,
  filed_at date,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Customer: A B2B customer (retailer). (identifier id)
CREATE TABLE IF NOT EXISTS projection.customer (
  id text PRIMARY KEY,
  name text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('A', 'B')),
  penalty_pct_per_week_late double precision NOT NULL,
  contact text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- SalesOrder: A customer order with a promised delivery date. (identifier id)
CREATE TABLE IF NOT EXISTS projection.sales_order (
  id text PRIMARY KEY,
  customer text NOT NULL,
  product text NOT NULL,
  qty bigint NOT NULL,
  fabric text NOT NULL,
  promised_delivery date NOT NULL,
  communicated_delivery date,
  status text NOT NULL CHECK (status IN ('confirmed', 'confirmed_unplanned')),
  source text,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- CustomerNotice: A message sent to a customer about their orders (recorded, not delivered). (identifier id)
CREATE TABLE IF NOT EXISTS projection.customer_notice (
  id text PRIMARY KEY,
  customer text NOT NULL,
  orders text[] NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  recipient text,
  sent_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- Campaign: A marketing campaign that drives order intake. (identifier id)
CREATE TABLE IF NOT EXISTS projection.campaign (
  id text PRIMARY KEY,
  name text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  daily_budget_pct double precision NOT NULL,
  note text,
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- DemandSignal: Planned order intake per sales order (basis of the production plan and the demand trend). (identifier sales_order_id)
CREATE TABLE IF NOT EXISTS projection.demand_signal (
  sales_order_id text PRIMARY KEY,
  customer text NOT NULL,
  product text NOT NULL CHECK (product IN ('LUND', 'OSLO', 'BERGEN')),
  qty bigint NOT NULL,
  promised_delivery date NOT NULL,
  source text NOT NULL CHECK (source IN ('plan', 'campaign')),
  version bigint NOT NULL DEFAULT 1,
  updated_seq bigint NOT NULL DEFAULT 0,
  ord bigint NOT NULL DEFAULT 0
);

-- foreign keys of single-valued links (deferred: a transaction may write both ends)
ALTER TABLE projection.machine DROP CONSTRAINT IF EXISTS machine_factory_fk, ADD CONSTRAINT machine_factory_fk FOREIGN KEY (factory) REFERENCES projection.factory (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.worker DROP CONSTRAINT IF EXISTS worker_factory_fk, ADD CONSTRAINT worker_factory_fk FOREIGN KEY (factory) REFERENCES projection.factory (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.absence DROP CONSTRAINT IF EXISTS absence_worker_fk, ADD CONSTRAINT absence_worker_fk FOREIGN KEY (worker) REFERENCES projection.worker (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.overtime_shift DROP CONSTRAINT IF EXISTS overtime_shift_factory_fk, ADD CONSTRAINT overtime_shift_factory_fk FOREIGN KEY (factory) REFERENCES projection.factory (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.temp_worker_assignment DROP CONSTRAINT IF EXISTS temp_worker_assignment_factory_fk, ADD CONSTRAINT temp_worker_assignment_factory_fk FOREIGN KEY (factory) REFERENCES projection.factory (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.inventory_item DROP CONSTRAINT IF EXISTS inventory_item_sku_fk, ADD CONSTRAINT inventory_item_sku_fk FOREIGN KEY (sku) REFERENCES projection.material (sku) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.purchase_order DROP CONSTRAINT IF EXISTS purchase_order_supplier_fk, ADD CONSTRAINT purchase_order_supplier_fk FOREIGN KEY (supplier) REFERENCES projection.supplier (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.purchase_order DROP CONSTRAINT IF EXISTS purchase_order_sku_fk, ADD CONSTRAINT purchase_order_sku_fk FOREIGN KEY (sku) REFERENCES projection.material (sku) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.production_order DROP CONSTRAINT IF EXISTS production_order_sales_order_fk, ADD CONSTRAINT production_order_sales_order_fk FOREIGN KEY (sales_order) REFERENCES projection.sales_order (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.production_order DROP CONSTRAINT IF EXISTS production_order_factory_fk, ADD CONSTRAINT production_order_factory_fk FOREIGN KEY (factory) REFERENCES projection.factory (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.production_order DROP CONSTRAINT IF EXISTS production_order_product_fk, ADD CONSTRAINT production_order_product_fk FOREIGN KEY (product) REFERENCES projection.bom (product) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.production_order DROP CONSTRAINT IF EXISTS production_order_fabric_fk, ADD CONSTRAINT production_order_fabric_fk FOREIGN KEY (fabric) REFERENCES projection.material (sku) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.maintenance_ticket DROP CONSTRAINT IF EXISTS maintenance_ticket_machine_fk, ADD CONSTRAINT maintenance_ticket_machine_fk FOREIGN KEY (machine) REFERENCES projection.machine (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.maintenance_ticket DROP CONSTRAINT IF EXISTS maintenance_ticket_required_part_fk, ADD CONSTRAINT maintenance_ticket_required_part_fk FOREIGN KEY (required_part) REFERENCES projection.material (sku) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.sales_order DROP CONSTRAINT IF EXISTS sales_order_customer_fk, ADD CONSTRAINT sales_order_customer_fk FOREIGN KEY (customer) REFERENCES projection.customer (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.sales_order DROP CONSTRAINT IF EXISTS sales_order_product_fk, ADD CONSTRAINT sales_order_product_fk FOREIGN KEY (product) REFERENCES projection.bom (product) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.sales_order DROP CONSTRAINT IF EXISTS sales_order_fabric_fk, ADD CONSTRAINT sales_order_fabric_fk FOREIGN KEY (fabric) REFERENCES projection.material (sku) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.customer_notice DROP CONSTRAINT IF EXISTS customer_notice_customer_fk, ADD CONSTRAINT customer_notice_customer_fk FOREIGN KEY (customer) REFERENCES projection.customer (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE projection.demand_signal DROP CONSTRAINT IF EXISTS demand_signal_customer_fk, ADD CONSTRAINT demand_signal_customer_fk FOREIGN KEY (customer) REFERENCES projection.customer (id) DEFERRABLE INITIALLY DEFERRED;
