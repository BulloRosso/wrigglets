import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonical, filterGraph, irHash, irToGraph, sourceHash, verifyIr } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const raw = JSON.parse(readFileSync(path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json'), 'utf8'));

describe('IR written by the Python compiler', () => {
  it('passes the schema and the hash computed in TypeScript equals the compiler hash', () => {
    const ir = verifyIr(raw);
    expect(ir.name).toBe('sofa');
    expect(irHash(ir)).toBe(raw.hash);
  });
  it('records the hashes of its source files (stale check)', () => {
    for (const f of ['schema.yaml', 'actions.yaml', 'bindings.yaml']) expect(raw.source.files[f]).toBe(sourceHash(readFileSync(path.join(root, 'ontology/sofa', f), 'utf8')));
  });
  it('rejects an edited IR (hash mismatch)', () => {
    const edited = structuredClone(raw);
    edited.classes[0].description = 'changed by hand';
    expect(() => verifyIr(edited)).toThrow(/hash mismatch/);
  });
  it('rejects dangling references', () => {
    const bad = structuredClone(raw);
    bad.actions[0].target = 'Nope';
    expect(() => verifyIr(bad)).toThrow(/unknown target Nope/);
  });
});

describe('canonical JSON', () => {
  it('sorts keys, drops undefined, keeps UTF-8 (same as the compiler)', () => {
    expect(canonical({ b: [1, 4.2, 'Süd'], a: { d: null, c: true, x: undefined } })).toBe('{"a":{"c":true,"d":null},"b":[1,4.2,"Süd"]}');
  });
});

describe('graph view', () => {
  const g = irToGraph(verifyIr(raw));
  it('has one node per class and one edge per link', () => {
    expect(g.nodes).toHaveLength(raw.classes.length);
    expect(g.edges).toHaveLength(raw.links.length);
    expect(g.edges.find((e) => e.id === 'Supplier.skus')).toMatchObject({ source: 'Supplier', target: 'Material', multivalued: true, label: 'skus [*]' });
  });
  it('puts targeted actions on their class and the rest in globalActions', () => {
    expect(g.nodes.find((n) => n.id === 'PurchaseOrder')!.actions.map((a) => a.name)).toEqual(['list_purchase_orders', 'create_purchase_order', 'cancel_purchase_order']);
    expect(g.globalActions.map((a) => a.name)).toEqual(['get_overview', 'get_kpi', 'simulate_change']);
  });
  it('lists only scalar/enum attributes as fields and marks bound classes', () => {
    const po = g.nodes.find((n) => n.id === 'PurchaseOrder')!;
    expect(po.fields.map((f) => f.name)).not.toContain('supplier');
    expect(po).toMatchObject({ criticality: 'payment_critical', bound: true });
    expect(g.nodes.find((n) => n.id === 'CustomerNotice')!.bound).toBe(false);
  });
  it('filters by text, group and criticality', () => {
    expect([...filterGraph(g, { text: 'supplier' })]).toContain('Supplier');
    expect([...filterGraph(g, { group: 'crm' })].sort()).toEqual(['Campaign', 'Customer', 'CustomerNotice', 'DemandSignal', 'SalesOrder']);
    expect([...filterGraph(g, { criticality: 'payment_critical' })]).toEqual(['PurchaseOrder']);
  });
});
