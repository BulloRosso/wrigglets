import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonical, verifyIr } from '@cw/ontology-ir';
import { CompileError, compileSources, dumpsIr } from './compile.js';

/* The TypeScript compiler replaces the Python one (ADR-0053): golden equality with the committed IR, plus the cases of
 * the former tools/ontology-compiler/tests/test_compiler.py. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sofa = Object.fromEntries(['schema.yaml', 'actions.yaml', 'bindings.yaml'].map((f) => [f, readFileSync(path.join(root, 'ontology/sofa', f), 'utf8')]));
const committed = readFileSync(path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json'), 'utf8');

const edit = (name: string, oldText: string, newText: string) => {
  expect(sofa[name], name).toContain(oldText);
  return { ...sofa, [name]: sofa[name]!.replace(oldText, newText) };
};
const errors = (files: Record<string, string>) => {
  try {
    compileSources(files);
  } catch (e) {
    if (e instanceof CompileError) return e.errors.map((x) => `${x.path}: ${x.message}`);
    throw e;
  }
  throw new Error('compiled without errors');
};

describe('golden: identical to the IR the Python compiler produced', () => {
  it('compiles the sofa ontology byte-identically (same file, same hash)', () => {
    const ir = compileSources(sofa);
    expect(dumpsIr(ir)).toBe(committed.replace(/\r\n/g, '\n'));
    expect(verifyIr(ir).hash).toBe(JSON.parse(committed).hash);
  });
});

describe('compile ok', () => {
  it('is deterministic and versioned', () => {
    const a = compileSources(sofa);
    expect(canonical(a)).toBe(canonical(compileSources(sofa)));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.irVersion).toBe(1);
  });
  it('the hash covers the content and the source files', () => {
    const a = compileSources(sofa);
    const b = compileSources(edit('schema.yaml', 'description: A plant that produces sofas.', 'description: A plant.'));
    expect(b.hash).not.toBe(a.hash);
    expect(b.source.files['schema.yaml']).not.toBe(a.source.files['schema.yaml']);
  });
  it('links and identifiers; identifiers are required', () => {
    const ir = compileSources(sofa);
    expect(ir.classes.find((c) => c.name === 'Factory')!.identifier).toBe('id');
    expect(ir.links).toContainEqual({ from: 'Machine', attribute: 'factory', to: 'Factory', required: true, multivalued: false });
    for (const c of ir.classes) expect(c.attributes.find((a) => a.identifier)!.required, c.name).toBe(true);
  });
});

describe('compile errors (collected, not first only)', () => {
  it.each([
    ['actions.yaml', 'target: PurchaseOrder\n    kind: create', 'target: Order\n    kind: create', "unknown class 'Order'"],
    ['actions.yaml', 'emits: [PurchaseOrderCreated]', 'emits: [PurchaseOrderMade]', "unknown event 'PurchaseOrderMade'"],
    ['actions.yaml', '    emits: [PurchaseOrderCreated]\n', '', 'must emit at least one event'],
    ['bindings.yaml', 'columns: { supplier: supplier_id }', 'columns: { vendor: supplier_id }', "'vendor' is not an attribute of PurchaseOrder"],
    ['bindings.yaml', '- { class: Factory, table: erp_factories, key: id }', '- { class: Plant, table: erp_factories, key: id }', "unknown class 'Plant'"],
    ['schema.yaml', 'rate_per_day: { range: integer', 'rate_per_day: { range: int', "unknown range 'int'"],
    ['schema.yaml', 'criticality: payment_critical, ', '', 'annotations.criticality'],
    ['actions.yaml', '  - name: get_kpi\n    kind: query\n    read_only: true', '  - name: get_kpi\n    kind: query', 'go together'],
    ['actions.yaml', '  - name: get_kpi\n', '  - name: get_kpi\n    readonly: true\n', "unknown key 'readonly'"],
  ])('%s: %s → %s', (file, oldText, newText, message) => {
    expect(errors(edit(file, oldText, newText)).some((e) => e.includes(message))).toBe(true);
  });
  it('reports several errors at once', () => {
    const files = { ...edit('actions.yaml', 'emits: [PurchaseOrderCreated]', 'emits: [Nope]') };
    files['bindings.yaml'] = files['bindings.yaml']!.replace('columns: { supplier: supplier_id }', 'columns: { vendor: supplier_id }');
    expect(errors(files).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the LinkML subset', () => {
  it('refuses features outside the subset with a clear error', () => {
    expect(errors(edit('schema.yaml', '  Machine:\n', '  Machine:\n    is_a: Factory\n'))).toContainEqual(expect.stringMatching(/classes\.Machine\.is_a: LinkML feature 'is_a' is not supported/));
    expect(errors(edit('schema.yaml', 'imports:\n  - linkml:types', 'imports:\n  - linkml:types\n  - ./other'))).toContainEqual("schema.yaml#imports: only 'linkml:types' can be imported");
    expect(errors(edit('schema.yaml', 'default_range: string', 'default_range: string\nslots: {}'))).toContainEqual(expect.stringMatching(/schema\.yaml#slots: LinkML feature 'slots'/));
  });
  it('canonical JSON matches the Python form', () => {
    expect(canonical({ b: [1, 4.2, 'Süd'], a: { d: null, c: true } })).toBe('{"a":{"c":true,"d":null},"b":[1,4.2,"Süd"]}');
  });

  it('declarative checks (ADR-0053): compiled into the IR, paths validated against the classes', () => {
    const check = [
      'checks:',
      '  supplier_must_be_ok:',
      '    subject: { class: PurchaseOrder, input: poId }',
      '    when: { path: supplier.status, equals: cannot_deliver }',
      '    require: { path: note, present: true }',
      '    message: "{subject.id}: supplier {subject.supplier} cannot deliver; a note is required"',
      '',
    ].join(String.fromCharCode(10));
    const ir = compileSources({ ...sofa, 'actions.yaml': `${sofa['actions.yaml']}${check}` });
    expect(ir.checks).toEqual([{ name: 'supplier_must_be_ok', subject: { class: 'PurchaseOrder', input: 'poId' }, when: { path: 'supplier.status', equals: 'cannot_deliver' }, require: { path: 'note', present: true }, message: '{subject.id}: supplier {subject.supplier} cannot deliver; a note is required' }]);
    expect(compileSources(sofa).checks).toBeUndefined(); // no checks → no key (the hash of existing IRs is unchanged)
    const bad = errors({ ...sofa, 'actions.yaml': `${sofa['actions.yaml']}${check.replace('supplier.status', 'supplier.colour').replace('{subject.supplier}', '{subject.vendor}')}` });
    expect(bad).toEqual(expect.arrayContaining([expect.stringMatching(/path 'supplier\.colour' does not resolve from PurchaseOrder/), expect.stringMatching(/message: path 'vendor'/)]));
  });
});
