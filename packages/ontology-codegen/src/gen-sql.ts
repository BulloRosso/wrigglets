import { classOf, enumOf, identifierOf, type IrAttribute, type OntologyIr } from '@cw/ontology-ir';
import { header, q, tableOf } from './util.js';

/*
 * Postgres DDL of the projection (M3): schema `projection`, one table per class, columns per attribute, a CHECK per
 * enum, `version`, `updated_seq` (the event seq that last changed the row) and `ord` (insertion order, so lists keep the
 * order in which objects were created). Single-valued links get a foreign key
 * (added after all tables exist, so declaration order and cycles do not matter); multi-valued links are text[] and
 * checked by the data-quality checks instead. The projection is a cache rebuilt from the event log (plan §1.3).
 */

function pgType(ir: OntologyIr, a: IrAttribute): string {
  let t: string;
  if (a.rangeKind === 'class') t = 'text';
  else if (a.rangeKind === 'enum') t = 'text';
  else t = { string: 'text', integer: 'bigint', float: 'double precision', boolean: 'boolean', date: 'date', datetime: 'timestamptz' }[a.range] ?? 'text';
  return a.multivalued ? `${t}[]` : t;
}

export function genSql(ir: OntologyIr): string {
  const out: string[] = [header(ir, '--'), 'CREATE SCHEMA IF NOT EXISTS projection;', ''];
  const fks: string[] = [];
  for (const c of ir.classes) {
    const id = identifierOf(c);
    const cols: string[] = [];
    for (const a of c.attributes) {
      let col = `  ${a.name} ${pgType(ir, a)}`;
      if (a.identifier) col += ' PRIMARY KEY';
      else if (a.required) col += ' NOT NULL';
      if (a.rangeKind === 'enum') {
        const values = enumOf(ir, a.range)!.values.map((v) => q(v.value)).join(', ');
        col += a.multivalued ? ` CHECK (${a.name} <@ ARRAY[${values}]::text[])` : ` CHECK (${a.name} IN (${values}))`;
      }
      cols.push(col);
      if (a.rangeKind === 'class' && !a.multivalued) {
        const target = classOf(ir, a.range)!;
        // drop + add keeps the DDL idempotent (the server applies it on every start)
        fks.push(`ALTER TABLE projection.${tableOf(c.name)} DROP CONSTRAINT IF EXISTS ${tableOf(c.name)}_${a.name}_fk, ADD CONSTRAINT ${tableOf(c.name)}_${a.name}_fk FOREIGN KEY (${a.name}) REFERENCES projection.${tableOf(target.name)} (${identifierOf(target).name}) DEFERRABLE INITIALLY DEFERRED;`);
      }
    }
    cols.push('  version bigint NOT NULL DEFAULT 1', '  updated_seq bigint NOT NULL DEFAULT 0', '  ord bigint NOT NULL DEFAULT 0');
    out.push(`-- ${c.name}: ${c.description ?? ''} (identifier ${id.name})`.trimEnd(), `CREATE TABLE IF NOT EXISTS projection.${tableOf(c.name)} (`, cols.join(',\n'), ');', '');
  }
  out.push('-- foreign keys of single-valued links (deferred: a transaction may write both ends)');
  out.push(...fks, '');
  return out.join('\n');
}
