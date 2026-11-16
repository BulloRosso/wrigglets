import type { OntologyIr } from '@cw/ontology-ir';

export type Files = Record<string, string>;

/** Header of every generated file (plan §1.3 invariant 4: generated files are never edited by hand). */
export const header = (ir: OntologyIr, comment: '//' | '--' | '#') => `${comment} GENERATED from ontology ${ir.name}@${ir.version} (${ir.hash.slice(0, 12)}) — do not edit; run node scripts/liquid/ontology-build.mjs\n`;

export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
export const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
export const pascal = (s: string) => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};
/** Postgres table of a class in the projection schema. */
export const tableOf = (cls: string) => snake(cls);
export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const js = (v: unknown) => JSON.stringify(v);
/** Stable pretty JSON with a trailing newline. */
export const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
