import { describe, expect, it } from 'vitest';
import { irHash, verifyIr, type OntologyIr } from '@cw/ontology-ir';
import { dqChecks, generateAll, genSql, genTypes, mcpTools, opaData, snake } from './index.js';

/* Generators on a tiny synthetic ontology: the rules, independent of the sofa company. */

function mini(): OntologyIr {
  const hex = 'a'.repeat(64);
  const ir = {
    irVersion: 1 as const,
    name: 'mini',
    version: '1.2.3',
    source: { files: { 'schema.yaml': hex }, hash: hex },
    enums: [{ name: 'Color', values: [{ value: 'red' }, { value: 'blue' }] }],
    classes: [
      {
        name: 'OrderLine',
        identifier: 'id',
        annotations: { criticality: 'payment_critical' as const, data_class: 'confidential' as const, owner: 'sales' },
        attributes: [
          { name: 'id', range: 'string', rangeKind: 'type' as const, required: true, multivalued: false, identifier: true },
          { name: 'product', range: 'Product', rangeKind: 'class' as const, required: true, multivalued: false, identifier: false },
          { name: 'colors', range: 'Color', rangeKind: 'enum' as const, required: false, multivalued: true, identifier: false },
          { name: 'qty', range: 'integer', rangeKind: 'type' as const, required: true, multivalued: false, identifier: false },
        ],
      },
      {
        name: 'Product',
        identifier: 'sku',
        annotations: { criticality: 'normal' as const, data_class: 'public' as const, owner: 'catalog' },
        attributes: [
          { name: 'sku', range: 'string', rangeKind: 'type' as const, required: true, multivalued: false, identifier: true },
          { name: 'tags', range: 'Product', rangeKind: 'class' as const, required: false, multivalued: true, identifier: false },
        ],
      },
    ],
    links: [
      { from: 'OrderLine', attribute: 'product', to: 'Product', required: true, multivalued: false },
      { from: 'Product', attribute: 'tags', to: 'Product', required: false, multivalued: true },
    ],
    events: [{ name: 'LineAdded', objectType: 'OrderLine' }],
    actions: [
      { name: 'list_lines', description: 'List', kind: 'query' as const, readOnly: true, destructive: false, input: [], preconditions: [], emits: [] },
      {
        name: 'add_line',
        description: 'WRITE. Add',
        target: 'OrderLine',
        kind: 'create' as const,
        readOnly: false,
        destructive: false,
        mcpGroup: 'erp',
        input: [
          { name: 'productId', range: 'Product', rangeKind: 'class' as const, required: true, multivalued: false, description: 'Product' },
          { name: 'qty', range: 'integer', rangeKind: 'type' as const, required: true, multivalued: false },
          { name: 'day', range: 'date', rangeKind: 'type' as const, required: false, multivalued: false },
          { name: 'colors', range: 'Color', rangeKind: 'enum' as const, required: false, multivalued: true },
        ],
        preconditions: ['product_exists'],
        emits: ['LineAdded'],
      },
    ],
    bindings: [],
  };
  return verifyIr({ ...ir, hash: irHash(ir) });
}

describe('generators', () => {
  const ir = mini();

  it('names: PascalCase class -> snake_case table', () => {
    expect(snake('OrderLine')).toBe('order_line');
    expect(snake('InventoryItem')).toBe('inventory_item');
  });

  it('SQL: tables first, then deferred FKs for single-valued links only; enum CHECKs incl. arrays', () => {
    const sql = genSql(ir);
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS projection.product')).toBeLessThan(sql.indexOf('ALTER TABLE'));
    expect(sql).toContain('ALTER TABLE projection.order_line DROP CONSTRAINT IF EXISTS order_line_product_fk, ADD CONSTRAINT order_line_product_fk FOREIGN KEY (product) REFERENCES projection.product (sku) DEFERRABLE INITIALLY DEFERRED;');
    expect(sql).not.toContain('product_tags_fk');
    expect(sql).toContain("colors text[] CHECK (colors <@ ARRAY['red', 'blue']::text[])");
    expect(sql).toContain('qty bigint NOT NULL');
    expect(sql).toMatch(/version bigint NOT NULL DEFAULT 1,\n {2}updated_seq bigint NOT NULL DEFAULT 0,\n {2}ord bigint NOT NULL DEFAULT 0/);
  });

  it('MCP: JSON types, required, hints; read-only tools carry no destructiveHint', () => {
    const [list, add] = mcpTools(ir);
    expect(list!.annotations).toEqual({ readOnlyHint: true });
    expect(add!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(add!.inputSchema.required).toEqual(['productId', 'qty']);
    expect(add!.inputSchema.properties).toEqual({
      productId: { type: 'string', description: 'Product' },
      qty: { type: 'integer' },
      day: { type: 'string', format: 'date' },
      colors: { type: 'array', items: { type: 'string', enum: ['red', 'blue'] } },
    });
  });

  it('types: enums, links as ids, optional vs nullish', () => {
    const ts = genTypes(ir);
    expect(ts).toContain('export const Color = z.enum(["red","blue"]);');
    expect(ts).toContain('  product: z.string().min(1),');
    expect(ts).toContain('  colors: z.array(Color).nullish(),');
    expect(ts).toContain('  day: z.iso.date().optional(),');
    expect(ts).toContain('add_line: AddLineInput,');
  });

  it('DQ: required, enum and link checks; multi-valued links via unnest', () => {
    const ids = dqChecks(ir).map((c) => c.id);
    expect(ids).toEqual(['OrderLine.product.required', 'OrderLine.product.link', 'OrderLine.colors.enum', 'OrderLine.qty.required', 'Product.tags.link']);
    expect(dqChecks(ir).find((c) => c.id === 'Product.tags.link')!.sql).toContain('unnest(s.tags)');
  });

  it('OPA: actions inherit the classification of their target', () => {
    const d = opaData(ir).liquid.ontology;
    expect(d.actions.add_line).toMatchObject({ target: 'OrderLine', criticality: 'payment_critical', data_class: 'confidential', owner: 'sales', read_only: false });
    expect(d.actions.list_lines).toMatchObject({ target: null, criticality: 'normal' });
  });

  it('is deterministic and puts the header on every file', () => {
    const a = generateAll(ir);
    expect(generateAll(mini())).toEqual(a);
    for (const [p, c] of Object.entries(a)) expect(c, p).toMatch(/GENERATED from ontology mini@1\.2\.3 \(aaaaaaaaaaaa\)|GENERATED from ontology mini@1\.2\.3/);
  });
});
