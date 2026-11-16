import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffIr, type OntologyIr } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = JSON.parse(readFileSync(path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json'), 'utf8')) as OntologyIr;

describe('diffIr', () => {
  it('no changes for the same IR', () => {
    const d = diffIr(base, structuredClone(base));
    expect(d.changes).toEqual([]);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('reports added class, added attribute, changed annotation and removed action, and colours the classes', () => {
    const b = structuredClone(base);
    b.version = '0.2.0';
    b.classes.push({ name: 'Carrier', identifier: 'id', annotations: { criticality: 'normal', data_class: 'internal', owner: 'logistics' }, attributes: [{ name: 'id', range: 'string', rangeKind: 'type', required: true, multivalued: false, identifier: true }] });
    const sup = b.classes.find((c) => c.name === 'Supplier')!;
    sup.attributes.push({ name: 'sustainability_score', range: 'integer', rangeKind: 'type', required: false, multivalued: false, identifier: false });
    sup.annotations.criticality = 'payment_critical';
    b.actions = b.actions.filter((a) => a.name !== 'release_purchase_order');
    const d = diffIr(base, b);
    expect(d.changes.map((c) => `${c.kind} ${c.element} ${c.path}`)).toEqual(
      expect.arrayContaining(['changed meta version', 'added class Carrier', 'changed class Supplier', 'added attribute Supplier.sustainability_score', 'removed action release_purchase_order']),
    );
    expect(d.changes.find((c) => c.path === 'Supplier' && c.element === 'class')?.fields).toEqual(['annotations.criticality']);
    expect(d.classes).toMatchObject({ Carrier: 'added', Supplier: 'changed', PurchaseOrder: 'changed' });
  });
});
