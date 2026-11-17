import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { dqChecks, genSql, mcpTools, opaData as opaDataOf } from '@cw/ontology-codegen';
import { inputValidator } from '@cw/ontology-ir';
import { loadIr } from './index.js';

// computed from the IR at runtime by the enterprise core (ADR-0049); tested here against the built-in ontology
const MCP_TOOLS = mcpTools(loadIr());
const DQ_CHECKS = dqChecks(loadIr());
const projectionSql = () => genSql(loadIr());
const opaData = () => opaDataOf(loadIr()) as Record<string, unknown>;

type MockTool = { name: string; write?: boolean; inputSchema: { properties?: Record<string, Record<string, unknown>>; required?: string[] } };
// @ts-expect-error plain .mjs without types; importing does not start the mock server
const mock = (await import('../../../scripts/sofa-company/mock-mcp.mjs')) as { SERVERS: Record<string, { tools: MockTool[] }> };

describe('MCP tools match the mock one to one (M2 exit criterion)', () => {
  const mockTools = Object.entries(mock.SERVERS).flatMap(([group, s]) => s.tools.map((t) => ({ ...t, group })));
  it('same names in the same groups', () => {
    // tools without a group (e.g. release_purchase_order, M5) are served on /onto only and are not part of the parity
    expect(MCP_TOOLS.filter((t) => t.group).map((t) => `${t.group}/${t.name}`).sort()).toEqual(mockTools.map((t) => `${t.group}/${t.name}`).sort());
  });
  it.each(mockTools.map((t) => [t.name, t] as const))('%s: flags, fields, types, required, enums, descriptions', (name, m) => {
    const g = MCP_TOOLS.find((t) => t.name === name)!;
    expect(g.annotations.readOnlyHint, 'readOnlyHint').toBe(!m.write);
    if (m.write) expect((g.annotations as { destructiveHint?: boolean }).destructiveHint, 'destructiveHint').toBe(['write_off_stock', 'cancel_purchase_order'].includes(name));
    const mp = m.inputSchema.properties ?? {};
    const gp = g.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(gp).sort(), 'fields').toEqual(Object.keys(mp).sort());
    expect([...g.inputSchema.required].sort(), 'required').toEqual([...(m.inputSchema.required ?? [])].sort());
    for (const [k, v] of Object.entries(mp)) {
      expect(gp[k]!.type, `${k}.type`).toBe(v.type);
      expect(gp[k]!.enum, `${k}.enum`).toEqual(v.enum);
      expect(gp[k]!.description, `${k}.description`).toBe(v.description);
      if (v.items) expect((gp[k]!.items as { type: string }).type, `${k}.items`).toBe((v.items as { type: string }).type);
    }
  });
});

describe('projection DDL and data-quality checks', () => {
  it('the DDL applies to an empty Postgres, one table per class, and again (idempotent: applied on every start)', async () => {
    const db = new PGlite();
    await db.exec(projectionSql());
    await db.exec(projectionSql());
    const t = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'projection'");
    expect(t.rows[0]!.n).toBe(loadIr().classes.length);
    await db.close();
  });

  it('DQ checks pass on consistent data and catch what the DDL cannot', async () => {
    const db = new PGlite();
    await db.exec(projectionSql());
    await db.exec(`INSERT INTO projection.factory (id, name) VALUES ('F-NORTH', 'Werk Nord');
      INSERT INTO projection.material (sku, name, unit, unit_cost) VALUES ('BEAM-PINE-80', 'Pine beam', 'pcs', 4.2);
      INSERT INTO projection.supplier (id, name, skus, lead_workdays, unit_price, min_qty, max_qty, rating, status) VALUES ('S-1', 'Nordholz', ARRAY['BEAM-PINE-80'], 8, 4.2, 1, 9, 'A', 'ok');`);
    const run = async () => Object.fromEntries(await Promise.all(DQ_CHECKS.map(async (c) => [c.id, Number((await db.query<{ violations: number }>(c.sql)).rows[0]!.violations)] as const)));
    expect(Object.entries(await run()).filter(([, v]) => v !== 0)).toEqual([]);
    // a multi-valued link to a material that does not exist: no FK can stop it, the DQ check finds it
    await db.exec(`UPDATE projection.supplier SET skus = ARRAY['BEAM-PINE-80', 'NOPE'] WHERE id = 'S-1'`);
    expect((await run())['Supplier.skus.link']).toBe(1);
    // the DDL itself rejects an unknown enum value and a dangling single-valued link
    await expect(db.exec(`UPDATE projection.supplier SET status = 'bankrupt'`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO projection.machine (id, factory, name, rate_per_day, status) VALUES ('X-1', 'F-NOPE', 'x', 1, 'running')`)).rejects.toThrow();
    await db.close();
  });
});

describe('input validation and OPA data from the IR', () => {
  it('action inputs of the sofa company are validated from the IR (runtime, no generated types)', () => {
    expect(inputValidator(loadIr(), 'create_purchase_order')!.safeParse({ supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 3000 }).success).toBe(true);
    expect(inputValidator(loadIr(), 'request_overtime')!.safeParse({ factory: 'F-NORTH', from: 'tomorrow', to: '2026-10-09' }).success).toBe(false);
  });
  it('OPA data classifies classes and actions', () => {
    const d = opaData() as { liquid: { ontology: { classes: Record<string, { criticality: string }>; actions: Record<string, { criticality: string; destructive: boolean }> } } };
    expect(d.liquid.ontology.classes.PurchaseOrder!.criticality).toBe('payment_critical');
    expect(d.liquid.ontology.actions.cancel_purchase_order).toMatchObject({ criticality: 'payment_critical', destructive: true });
  });
});
