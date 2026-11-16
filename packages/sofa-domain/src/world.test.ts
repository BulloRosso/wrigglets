import { describe, expect, it } from 'vitest';
import { extractCounts, sofaExtract } from './extract.js';
import { CAMPAIGN_SALES, PRODUCTS, SALES, SKU, TODAY, freshWorld } from './world.js';

// The mock is the reference implementation (scripts/sofa-company/mock-mcp.mjs); importing it does not start a server.
// @ts-expect-error plain .mjs without types
const mock = (await import('../../../scripts/sofa-company/mock-mcp.mjs')) as Record<string, unknown> & { freshWorld: () => unknown };

describe('parity with the mock', () => {
  it('initial world is identical', () => {
    expect(freshWorld().world).toEqual(mock.freshWorld());
  });
  it('constants are identical', () => {
    expect({ TODAY, PRODUCTS, SKU, SALES, CAMPAIGN_SALES }).toEqual({ TODAY: mock.TODAY, PRODUCTS: mock.PRODUCTS, SKU: mock.SKU, SALES: mock.SALES, CAMPAIGN_SALES: mock.CAMPAIGN_SALES });
  });
  it('production order ids continue from the same sequence', () => {
    const { world, seq } = freshWorld();
    expect(world.productionOrders.at(-1)!.id).toBe('PRD-4217');
    expect(seq.prd).toBe(4218);
  });
});

describe('raw extract', () => {
  const tables = sofaExtract(freshWorld().world);
  it('has one table per entity with the expected row counts', () => {
    expect(extractCounts(tables)).toEqual({
      erp_factories: 2, erp_machines: 6, erp_workers: 4, erp_absences: 0, erp_materials: 5, erp_bom: 3, erp_suppliers: 7, erp_inventory: 5,
      erp_purchase_orders: 4, erp_production_orders: 18, erp_maintenance_tickets: 0, crm_customers: 6, crm_orders: 18, crm_campaigns: 1, crm_demand: 18,
    });
  });
  it('every row has exactly the declared columns', () => {
    for (const t of tables) for (const r of t.rows) expect(Object.keys(r).sort()).toEqual(t.columns.map((c) => c.name).sort());
  });
});
