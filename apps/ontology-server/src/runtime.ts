import { genSql } from '@cw/ontology-codegen';
import { diffIr, type IrAttribute, type IrClass, type OntologyIr } from '@cw/ontology-ir';
import { worldToObjects, type Args, type CompanyWorld, type Objects, type Row, type ToolResult } from '@cw/sofa-domain';

/*
 * The ontology interpreted at runtime (M8, ADR-0048). The domain package implements the actions of the ontology it was
 * written for (built-in IR); everything a newer ontology version adds is handled here from the IR alone:
 *   - extension state: objects of classes the domain does not know, and attributes the domain does not know on its
 *     classes (e.g. PurchaseOrder.carrier) — kept beside the domain world, written as events like everything else
 *   - generic handlers for actions without code: query (filter by inputs), create, update, delete
 *   - projection DDL and migrations computed from the IR and the difference of two versions
 */

export interface Ext {
  /** Objects of classes the domain does not know. */
  classes: Objects;
  /** Extra attributes of domain objects: class → id → attribute → value. */
  extras: Record<string, Record<string, Record<string, unknown>>>;
}
export const emptyExt = (): Ext => ({ classes: {}, extras: {} });
export const cloneExt = (e: Ext): Ext => structuredClone(e);

/** Classes and attributes the domain code implements (the built-in IR). */
export interface DomainModel {
  classes: Set<string>;
  attributes: Map<string, Set<string>>;
  identifier: (cls: string) => string;
}
export function domainModel(builtin: OntologyIr): DomainModel {
  const attributes = new Map(builtin.classes.map((c) => [c.name, new Set(c.attributes.map((a) => a.name))]));
  return { classes: new Set(builtin.classes.map((c) => c.name)), attributes, identifier: (cls) => builtin.classes.find((c) => c.name === cls)?.identifier ?? 'id' };
}
export const identifierIn = (ir: OntologyIr, cls: string) => ir.classes.find((c) => c.name === cls)?.identifier ?? 'id';

/** The current objects of every class of `ir`: domain world + extension state (merged). */
export function objectsOf(W: CompanyWorld, ext: Ext, ir: OntologyIr, dm: DomainModel): Objects {
  const base = worldToObjects(W);
  const out: Objects = {};
  for (const c of ir.classes) {
    if (dm.classes.has(c.name)) {
      const extras = ext.extras[c.name] ?? {};
      const id = identifierIn(ir, c.name);
      const known = new Set(c.attributes.map((a) => a.name));
      out[c.name] = (base[c.name] ?? []).map((r) => {
        const x = extras[String(r[id])];
        // attributes removed from the ontology disappear from the objects (the domain may still keep them internally)
        const row = Object.fromEntries(Object.entries(r).filter(([k]) => k === 'ord' || known.has(k) || !dm.attributes.get(c.name)?.has(k))) as Row;
        return x ? ({ ...row, ...Object.fromEntries(Object.entries(x).filter(([k]) => known.has(k))) } as Row) : row;
      });
    } else out[c.name] = (ext.classes[c.name] ?? []).map((r) => ({ ...r }));
  }
  return out;
}

/** Splits projection rows into the extension state (rows of the domain classes go to the domain world). */
export function extFromObjects(o: Objects, ir: OntologyIr, dm: DomainModel): Ext {
  const ext = emptyExt();
  for (const c of ir.classes) {
    const rows = o[c.name] ?? [];
    if (!dm.classes.has(c.name)) {
      ext.classes[c.name] = rows.map((r) => ({ ...r }));
      continue;
    }
    const extra = c.attributes.filter((a) => !dm.attributes.get(c.name)?.has(a.name)).map((a) => a.name);
    if (!extra.length) continue;
    const id = identifierIn(ir, c.name);
    for (const r of rows) {
      const vals = Object.fromEntries(extra.filter((k) => r[k] !== null && r[k] !== undefined).map((k) => [k, r[k]]));
      if (Object.keys(vals).length) (ext.extras[c.name] ??= {})[String(r[id])] = vals;
    }
  }
  return ext;
}

/* ------------------------------------------------------------------------------------------ generic actions */

const text = (v: unknown): ToolResult => ({ text: typeof v === 'string' ? v : JSON.stringify(v, null, 2), isError: false });
const err = (t: string): ToolResult => ({ text: t, isError: true });
const clean = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'ord' && v !== null && v !== undefined));
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Attribute an input sets: same name, snake_case of it, or `<link>Id` for a class-typed attribute. */
function attributeFor(c: IrClass, input: string): IrAttribute | undefined {
  return c.attributes.find((a) => a.name === input || a.name === snake(input) || (a.rangeKind === 'class' && (input === `${a.name}Id` || snake(input) === `${a.name}_id`)));
}

export function genericAction(ir: OntologyIr, dm: DomainModel, name: string, args: Args, W: CompanyWorld, ext: Ext): ToolResult {
  const a = ir.actions.find((x) => x.name === name);
  if (!a) return err(`Unknown tool ${name}`);
  const cls = a.target ? ir.classes.find((c) => c.name === a.target) : undefined;
  if (!cls) return err(`${name}: no implementation (no target class)`);
  const objects = objectsOf(W, ext, ir, dm);
  const rows = objects[cls.name] ?? [];
  const id = identifierIn(ir, cls.name);
  const domainClass = dm.classes.has(cls.name);
  const exists = (c: string, v: unknown) => (objects[c] ?? []).some((r) => String(r[identifierIn(ir, c)]) === String(v));

  if (a.kind === 'query') {
    const filters = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '');
    const out = rows.filter((r) =>
      filters.every(([k, v]) => {
        const at = attributeFor(cls, k);
        if (!at) return true;
        const got = r[at.name];
        return Array.isArray(got) ? got.map(String).includes(String(v)) : String(got) === String(v);
      }),
    );
    return text(out.map(clean));
  }

  const target = a.input.find((f) => f.rangeKind === 'class' && f.range === cls.name) ?? a.input.find((f) => f.name === id);
  const setters = a.input.filter((f) => f !== target && args[f.name] !== undefined);
  const values: Record<string, unknown> = {};
  for (const f of setters) {
    const at = attributeFor(cls, f.name);
    if (!at) continue;
    if (at.rangeKind === 'class') {
      const ids = Array.isArray(args[f.name]) ? (args[f.name] as unknown[]) : [args[f.name]];
      const missing = ids.filter((v) => !exists(at.range, v));
      if (missing.length) return err(`Unknown ${at.range} ${missing.join(', ')}`);
    }
    values[at.name] = args[f.name];
  }

  if (a.kind === 'create') {
    if (domainClass) return err(`${name}: creating ${cls.name} objects is implemented by the domain code, not generically`);
    const given = target ? args[target.name] : undefined;
    const prefix = cls.name.replace(/[^A-Z]/g, '').padEnd(2, cls.name[1]!.toUpperCase()).slice(0, 3) || cls.name.slice(0, 3).toUpperCase();
    let n = rows.length + 1;
    while (rows.some((r) => String(r[id]) === `${prefix}-${String(n).padStart(3, '0')}`)) n++;
    const newId = given !== undefined ? String(given) : `${prefix}-${String(n).padStart(3, '0')}`;
    if (rows.some((r) => String(r[id]) === newId)) return err(`${cls.name} ${newId} exists`);
    const missing = cls.attributes.filter((x) => x.required && !x.identifier && values[x.name] === undefined).map((x) => x.name);
    if (missing.length) return err(`${name}: missing ${missing.join(', ')}`);
    const row = { ...Object.fromEntries(cls.attributes.map((x) => [x.name, null])), ...values, [id]: newId, ord: rows.reduce((m, r) => Math.max(m, Number(r.ord ?? 0)), 0) + 1 } as Row;
    (ext.classes[cls.name] ??= []).push(row);
    return text(clean(row));
  }

  if (!target || args[target.name] === undefined) return err(`${name}: which ${cls.name}? (input ${target?.name ?? id})`);
  const key = String(args[target.name]);
  if (!rows.some((r) => String(r[id]) === key)) return err(`Unknown ${cls.name} ${key}`);

  if (a.kind === 'update') {
    if (!Object.keys(values).length) return err(`${name}: nothing to change`);
    if (domainClass) {
      const own = Object.keys(values).filter((k) => dm.attributes.get(cls.name)?.has(k));
      if (own.length) return err(`${name}: ${own.join(', ')} of ${cls.name} are changed by the domain code, not generically`);
      (ext.extras[cls.name] ??= {})[key] = { ...(ext.extras[cls.name]?.[key] ?? {}), ...values };
    } else {
      const row = ext.classes[cls.name]!.find((r) => String(r[id]) === key)!;
      Object.assign(row, values);
    }
    return text(clean(objectsOf(W, ext, ir, dm)[cls.name]!.find((r) => String(r[id]) === key)!));
  }
  if (a.kind === 'delete') {
    if (domainClass) return err(`${name}: deleting ${cls.name} objects is implemented by the domain code`);
    ext.classes[cls.name] = ext.classes[cls.name]!.filter((r) => String(r[id]) !== key);
    return text({ deleted: key });
  }
  return err(`${name}: ${a.kind} actions need an implementation in the domain code`);
}

/* ------------------------------------------------------------------------------------------ DDL and migration */

const pgType = (a: IrAttribute) => {
  const t = a.rangeKind === 'type' ? ({ integer: 'bigint', float: 'double precision', boolean: 'boolean', date: 'date', datetime: 'timestamptz' }[a.range] ?? 'text') : 'text';
  return a.multivalued ? `${t}[]` : t;
};
const tableOf = (cls: string) => cls.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** DDL of the projection for an IR (idempotent), plus the company meta table. */
export function ddlFor(schema: string, ir: OntologyIr): string {
  return `${genSql(ir).replace(/projection\./g, `${schema}.`).replace('CREATE SCHEMA IF NOT EXISTS projection;', `CREATE SCHEMA IF NOT EXISTS ${schema};`)}
CREATE TABLE IF NOT EXISTS ${schema}.company_meta (key text PRIMARY KEY, value jsonb NOT NULL, updated_seq bigint NOT NULL DEFAULT 0);`;
}

/**
 * Additive migration from `a` to `b` (patch/minor): new tables (from the DDL), new columns (nullable: existing rows have
 * no value), enum CHECKs widened. Breaking changes are not migrated in place — the projection is rebuilt instead.
 */
export function migrationSql(schema: string, a: OntologyIr, b: OntologyIr): string[] {
  // columns first (existing tables), then the DDL of `b` (new tables, foreign keys that may use the new columns)
  const out: string[] = [];
  const d = diffIr(a, b);
  const changedEnums = new Set(d.changes.filter((c) => c.element === 'enum' && c.kind === 'changed').map((c) => c.path));
  for (const c of b.classes) {
    if (!a.classes.some((x) => x.name === c.name)) continue; // created by the DDL
    const t = `${schema}.${tableOf(c.name)}`;
    const before = new Set(a.classes.find((x) => x.name === c.name)!.attributes.map((x) => x.name));
    for (const at of c.attributes) {
      if (!before.has(at.name)) out.push(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${at.name} ${pgType(at)}`);
      if (at.rangeKind === 'enum' && changedEnums.has(at.range)) {
        const values = b.enums.find((e) => e.name === at.range)!.values.map((v) => q(v.value)).join(', ');
        const name = `${tableOf(c.name)}_${at.name}_check`;
        out.push(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${name}, ADD CONSTRAINT ${name} CHECK (${at.multivalued ? `${at.name} <@ ARRAY[${values}]::text[]` : `${at.name} IN (${values})`})`);
      }
    }
  }
  out.push(ddlFor(schema, b));
  return out;
}
