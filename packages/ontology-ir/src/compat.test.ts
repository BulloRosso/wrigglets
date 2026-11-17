import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compatibility, inputValidator, resolveAction, type OntologyIr } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = JSON.parse(readFileSync(path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json'), 'utf8')) as OntologyIr;
const edit = (fn: (ir: OntologyIr) => void) => {
  const b = structuredClone(base);
  fn(b);
  return b;
};
const po = (ir: OntologyIr) => ir.classes.find((c) => c.name === 'PurchaseOrder')!;
const act = (ir: OntologyIr, n: string) => ir.actions.find((a) => a.name === n)!;
const carrier = { name: 'Carrier', identifier: 'id', annotations: { criticality: 'normal' as const, data_class: 'internal' as const, owner: 'head-of-logistics' }, attributes: [{ name: 'id', range: 'string', rangeKind: 'type' as const, required: true, multivalued: false, identifier: true }] };

describe('compatibility', () => {
  const cases: Array<[string, (ir: OntologyIr) => void, 'patch' | 'minor' | 'major', RegExp]> = [
    ['description', (ir) => (po(ir).description = 'changed'), 'patch', /description changed/],
    ['annotation', (ir) => (po(ir).annotations.owner = 'head-of-sales'), 'patch', /annotations.owner/],
    ['declarative check added (ADR-0053)', (ir) => (ir.checks = [{ name: 'x_check', subject: { class: 'PurchaseOrder', input: 'poId' }, require: { path: 'note', present: true }, message: 'needs a note' }]), 'minor', /new check/],
    ['precondition added to an action (M10 D3)', (ir) => act(ir, 'release_purchase_order').preconditions.push('due_diligence_for_high_risk_material'), 'minor', /preconditions changed/],
    ['new class + optional link (D3)', (ir) => {
      ir.classes.push(carrier);
      po(ir).attributes.push({ name: 'carrier', range: 'Carrier', rangeKind: 'class', required: false, multivalued: false, identifier: false });
    }, 'minor', /new class/],
    ['new action', (ir) => ir.actions.push({ ...act(ir, 'list_suppliers'), name: 'list_carriers' }), 'minor', /new action/],
    ['enum value added', (ir) => ir.enums[0]!.values.push({ value: 'maintenance' }), 'minor', /values added/],
    ['optional input added', (ir) => act(ir, 'create_purchase_order').input.push({ name: 'carrierId', range: 'string', rangeKind: 'type', required: false, multivalued: false }), 'minor', /new optional input/],
    ['rename with alias', (ir) => {
      const a = act(ir, 'list_suppliers');
      a.name = 'find_suppliers';
      a.aliases = ['list_suppliers'];
    }, 'minor', /renamed to find_suppliers/],
    ['required attribute added', (ir) => po(ir).attributes.push({ name: 'carrier', range: 'string', rangeKind: 'type', required: true, multivalued: false, identifier: false }), 'major', /new required attribute/],
    ['attribute removed', (ir) => (po(ir).attributes = po(ir).attributes.filter((a) => a.name !== 'note')), 'major', /attribute removed/],
    ['range narrowed', (ir) => (po(ir).attributes.find((a) => a.name === 'qty')!.range = 'integer'), 'major', /range float → integer/],
    ['optional → required', (ir) => (po(ir).attributes.find((a) => a.name === 'note')!.required = true), 'major', /optional → required/],
    ['action removed', (ir) => (ir.actions = ir.actions.filter((a) => a.name !== 'list_suppliers')), 'major', /action removed/],
    ['enum value removed', (ir) => ir.enums[0]!.values.pop(), 'major', /values removed/],
    ['required input added', (ir) => act(ir, 'create_purchase_order').input.push({ name: 'carrierId', range: 'string', rangeKind: 'type', required: true, multivalued: false }), 'major', /new required input/],
  ];
  for (const [name, fn, level, reason] of cases) {
    it(`${name} → ${level}`, () => {
      const c = compatibility(base, edit(fn));
      expect(c.level).toBe(level);
      expect(c.findings.map((f) => f.reason).join(' | ')).toMatch(reason);
    });
  }
  it('suggests the next version and checks the declared one', () => {
    const b = edit((ir) => ir.classes.push(carrier));
    expect(compatibility(base, b)).toMatchObject({ level: 'minor', suggestedVersion: '0.2.0', versionOk: false });
    b.version = '0.2.0';
    expect(compatibility(base, b).versionOk).toBe(true);
    expect(compatibility(base, structuredClone(base))).toMatchObject({ findings: [], versionOk: true });
  });
});

describe('runtime validation', () => {
  it('validates inputs like the generated schemas and resolves aliases', () => {
    const v = inputValidator(base, 'request_overtime')!;
    expect(v.safeParse({ factory: 'F-NORTH', from: '2026-10-06', to: '2026-10-07' }).success).toBe(true);
    expect(v.safeParse({ factory: 'F-NORTH', from: 'next monday', to: '2026-10-07' }).success).toBe(false);
    expect(inputValidator(base, 'create_purchase_order')!.safeParse({ supplierId: 'S-BALTIC', sku: 'X', quantity: '5' }).success).toBe(false);
    const b = edit((ir) => {
      const a = act(ir, 'list_suppliers');
      a.name = 'find_suppliers';
      a.aliases = ['list_suppliers'];
    });
    expect(resolveAction(b, 'list_suppliers')).toMatchObject({ action: { name: 'find_suppliers' }, viaAlias: 'list_suppliers' });
    expect(inputValidator(b, 'list_suppliers')).toBe(inputValidator(b, 'find_suppliers'));
  });
});
