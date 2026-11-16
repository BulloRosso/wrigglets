import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { DraftStore, applyOps } from './drafts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const schema = readFileSync(path.join(root, 'ontology/sofa/schema.yaml'), 'utf8');

describe('draft operations on schema.yaml', () => {
  it('add class, attribute, link, enum value, annotation; comments and untouched lines stay', () => {
    const out = applyOps(schema, [
      { op: 'add_class', name: 'Carrier', description: 'A logistics company that delivers purchase orders.', identifier: 'id', annotations: { criticality: 'normal', data_class: 'internal', owner: 'head-of-logistics' } },
      { op: 'add_attribute', class: 'Carrier', name: 'name', required: true },
      { op: 'add_link', from: 'PurchaseOrder', attribute: 'carrier', to: 'Carrier' },
      { op: 'add_enum_value', enum: 'SupplierRating', value: 'D', description: 'blocked' },
      { op: 'set_annotation', class: 'Supplier', key: 'criticality', value: 'business_critical' },
      { op: 'set_version', version: '0.2.0' },
    ]);
    const doc = YAML.parse(out);
    expect(doc.classes.Carrier).toEqual({ description: 'A logistics company that delivers purchase orders.', annotations: { criticality: 'normal', data_class: 'internal', owner: 'head-of-logistics' }, attributes: { id: { identifier: true }, name: { required: true } } });
    expect(doc.classes.PurchaseOrder.attributes.carrier).toEqual({ range: 'Carrier' });
    expect(doc.enums.SupplierRating.permissible_values.D).toEqual({ description: 'blocked' });
    expect(doc.classes.Supplier.annotations.criticality).toBe('business_critical');
    expect(doc.version).toBe('0.2.0');
    expect(out.startsWith('# The sofa company')).toBe(true);
    expect(out).toContain('      released_at: { range: date, description: Day the order was released to the supplier (PurchaseOrderRelease workflow) }');
    // every original line that was not touched is still there
    const touched = /^(version:|\s+annotations: \{ criticality: \w+, data_class: \w+, owner: [\w-]+, mcp_group: erp \}$)/;
    const missing = schema.split('\n').filter((l) => !touched.test(l) && !out.includes(l));
    expect(missing).toEqual([]);
  });

  it('update and remove attributes; the identifier cannot be removed', () => {
    const out = applyOps(schema, [
      { op: 'update_attribute', class: 'PurchaseOrder', name: 'note', description: 'free text' },
      { op: 'remove_attribute', class: 'PurchaseOrder', name: 'express' },
    ]);
    const po = YAML.parse(out).classes.PurchaseOrder.attributes;
    expect(po.note).toEqual({ description: 'free text' });
    expect(po.express).toBeUndefined();
    expect(() => applyOps(schema, [{ op: 'remove_attribute', class: 'PurchaseOrder', name: 'id' }])).toThrow(/identifier/);
  });

  it('rejects invalid operations', () => {
    expect(() => applyOps(schema, [{ op: 'add_class', name: 'bad name', identifier: 'id', annotations: { criticality: 'normal', data_class: 'internal', owner: 'x-y' } } as never])).toThrow();
    expect(() => applyOps(schema, [{ op: 'add_link', from: 'PurchaseOrder', attribute: 'x', to: 'Nope' }])).toThrow(/unknown class Nope/);
    expect(() => applyOps(schema, [{ op: 'add_attribute', class: 'Supplier', name: 'id', range: 'string' }])).toThrow(/exists/);
    expect(() => applyOps(schema, [{ op: 'drop_table' } as never])).toThrow();
  });

  it('draft store: create, apply ops, list per person', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cw-drafts-'));
    try {
      const s = new DraftStore(dir);
      const d = await s.create({ domain: 'sofa', base: 'abc', files: { 'schema.yaml': schema, 'actions.yaml': 'a', 'bindings.yaml': 'b' }, by: 'ada@x' });
      const d2 = await s.apply(d.id, [{ op: 'add_enum_value', enum: 'SupplierRating', value: 'D' }]);
      expect(d2.ops).toHaveLength(1);
      expect(YAML.parse(d2.files['schema.yaml']).enums.SupplierRating.permissible_values.D).toEqual({});
      expect((await s.list('ada@x')).map((x) => x.id)).toEqual([d.id]);
      expect(await s.list('ben@x')).toEqual([]);
      await expect(s.get('../etc')).rejects.toThrow(/bad draft id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
