import { classOf, enumOf, identifierOf, type OntologyIr } from '@cw/ontology-ir';
import { header, js, q, tableOf } from './util.js';

/*
 * Data-quality checks against the projection: each check is a SQL query returning the number of violating rows
 * (0 = pass). Required fields, enum values (also for arrays) and link integrity, including multi-valued links that
 * the DDL cannot cover with a foreign key.
 */

export interface DqCheck {
  id: string;
  class: string;
  kind: 'required' | 'enum' | 'link';
  description: string;
  sql: string;
}

export function dqChecks(ir: OntologyIr): DqCheck[] {
  const checks: DqCheck[] = [];
  for (const c of ir.classes) {
    const t = `projection.${tableOf(c.name)}`;
    for (const a of c.attributes) {
      if (a.required && !a.identifier) {
        const cond = a.multivalued ? `${a.name} IS NULL OR cardinality(${a.name}) = 0` : `${a.name} IS NULL`;
        checks.push({ id: `${c.name}.${a.name}.required`, class: c.name, kind: 'required', description: `${c.name}.${a.name} is set`, sql: `SELECT count(*) AS violations FROM ${t} WHERE ${cond}` });
      }
      if (a.rangeKind === 'enum') {
        const values = enumOf(ir, a.range)!.values.map((v) => q(v.value)).join(', ');
        const cond = a.multivalued ? `NOT (${a.name} <@ ARRAY[${values}]::text[])` : `${a.name} IS NOT NULL AND ${a.name} NOT IN (${values})`;
        checks.push({ id: `${c.name}.${a.name}.enum`, class: c.name, kind: 'enum', description: `${c.name}.${a.name} is one of ${a.range}`, sql: `SELECT count(*) AS violations FROM ${t} WHERE ${cond}` });
      }
      if (a.rangeKind === 'class') {
        const target = classOf(ir, a.range)!;
        const tt = `projection.${tableOf(target.name)}`;
        const tid = identifierOf(target).name;
        const sql = a.multivalued
          ? `SELECT count(*) AS violations FROM ${t} s, unnest(s.${a.name}) AS ref WHERE NOT EXISTS (SELECT 1 FROM ${tt} x WHERE x.${tid} = ref)`
          : `SELECT count(*) AS violations FROM ${t} s WHERE s.${a.name} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${tt} x WHERE x.${tid} = s.${a.name})`;
        checks.push({ id: `${c.name}.${a.name}.link`, class: c.name, kind: 'link', description: `${c.name}.${a.name} refers to an existing ${target.name}`, sql });
      }
    }
  }
  return checks;
}

export const genDq = (ir: OntologyIr) =>
  `${header(ir, '//')}export interface DqCheck { id: string; class: string; kind: 'required' | 'enum' | 'link'; description: string; sql: string }\n\nexport const DQ_CHECKS: DqCheck[] = ${js(dqChecks(ir))};\n`;
