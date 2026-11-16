import { createHash } from 'node:crypto';
import pg from 'pg';
import { projectionSql, DQ_CHECKS } from '@cw/ontology-sofa';
import { applyChanges, identifierAttr, SOFA_CLASSES, type Change, type CompanyMeta, type Objects, type Row } from '@cw/sofa-domain';

/** Table of a class in the projection (same rule as the DDL generator: PascalCase -> snake_case). */
export const tableOf = (cls: string) => cls.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();

/*
 * The projection (ADR-0043): current state of every object in schema `projection` of the ontology DB, generated DDL
 * (one table per class) plus `projection.company_meta` for company-level values. A cache: it is written in the same
 * transaction as the events and can be rebuilt from T0 + the event log at any time (rebuild into a scratch schema,
 * verify, swap).
 */

// pg returns DATE as a JS Date in local time and BIGINT as a string by default: keep dates as YYYY-MM-DD, bigints as
// numbers (ids are strings; counters are far below 2^53), timestamps as ISO strings like the domain uses.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
pg.types.setTypeParser(701, (v: string) => Number(v));

const SYSTEM_COLUMNS = new Set(['version', 'updated_seq', 'ord']);
export type Querier = Pick<pg.PoolClient, 'query'>;

export function ddlFor(schema: string): string {
  return `${projectionSql().replace(/projection\./g, `${schema}.`).replace('CREATE SCHEMA IF NOT EXISTS projection;', `CREATE SCHEMA IF NOT EXISTS ${schema};`)}
CREATE TABLE IF NOT EXISTS ${schema}.company_meta (key text PRIMARY KEY, value jsonb NOT NULL, updated_seq bigint NOT NULL DEFAULT 0);`;
}

/** Column names of a class table (without the system columns), cached per schema. */
async function columns(q: Querier, schema: string, cls: string): Promise<string[]> {
  const r = await q.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', [schema, tableOf(cls)]);
  return r.rows.map((x) => x.column_name).filter((c) => !SYSTEM_COLUMNS.has(c));
}

export async function upsert(q: Querier, schema: string, changes: Change[], seq: number, cols: Map<string, string[]>) {
  for (const c of changes) {
    const t = `${schema}.${tableOf(c.class)}`;
    const key = identifierAttr(c.class);
    if (c.after === null) {
      await q.query(`DELETE FROM ${t} WHERE ${key} = $1`, [c.id]);
      continue;
    }
    const names = cols.get(c.class) ?? (await columns(q, schema, c.class));
    cols.set(c.class, names);
    const values = names.map((n) => (c.after as Row)[n] ?? null);
    const ph = names.map((_n, i) => `$${i + 1}`);
    await q.query(
      `INSERT INTO ${t} (${names.join(', ')}, version, updated_seq, ord) VALUES (${ph.join(', ')}, 1, $${names.length + 1}, $${names.length + 2})
       ON CONFLICT (${key}) DO UPDATE SET ${names.map((n) => `${n} = EXCLUDED.${n}`).join(', ')}, version = ${t}.version + 1, updated_seq = EXCLUDED.updated_seq, ord = EXCLUDED.ord`,
      [...values, seq, c.after.ord],
    );
  }
}

export async function setMeta(q: Querier, schema: string, meta: CompanyMeta, seq: number) {
  await q.query(`INSERT INTO ${schema}.company_meta (key, value, updated_seq) VALUES ('company', $1::jsonb, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_seq = EXCLUDED.updated_seq`, [JSON.stringify(meta), seq]);
}

export async function loadObjects(q: Querier, schema: string): Promise<{ objects: Objects; meta: CompanyMeta | null }> {
  const objects: Objects = {};
  for (const cls of SOFA_CLASSES) {
    const r = await q.query<Row & { version: number; updated_seq: number }>(`SELECT * FROM ${schema}.${tableOf(cls)} ORDER BY ord`);
    objects[cls] = r.rows.map(({ version: _v, updated_seq: _u, ...row }) => row as Row);
  }
  const m = await q.query<{ value: CompanyMeta }>(`SELECT value FROM ${schema}.company_meta WHERE key = 'company'`);
  return { objects, meta: m.rows[0]?.value ?? null };
}

/** Writes the T0 state (all objects, seq 0). */
export async function seed(q: Querier, schema: string, t0: Objects, meta: CompanyMeta) {
  const changes: Change[] = SOFA_CLASSES.flatMap((cls) => (t0[cls] ?? []).map((row) => ({ class: cls, id: String(row[identifierAttr(cls)]), after: row })));
  await upsert(q, schema, changes, 0, new Map());
  await setMeta(q, schema, meta, 0);
}

/** Order-independent fingerprint of a projection schema: every table's rows (incl. version/updated_seq/ord) and the meta. */
export async function rowHash(q: Querier, schema: string): Promise<{ hash: string; tables: Record<string, number> }> {
  const h = createHash('sha256');
  const tables: Record<string, number> = {};
  for (const cls of [...SOFA_CLASSES].sort()) {
    const key = identifierAttr(cls);
    const r = await q.query<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM ${schema}.${tableOf(cls)} t ORDER BY ${key}`);
    tables[cls] = r.rows.length;
    h.update(cls);
    for (const x of r.rows) h.update(x.j);
  }
  const m = await q.query<{ j: string }>(`SELECT value::text AS j FROM ${schema}.company_meta ORDER BY key`);
  for (const x of m.rows) h.update(x.j);
  return { hash: h.digest('hex'), tables };
}

/** Runs the generated data-quality checks against a projection schema. */
export async function runDq(q: Querier, schema = 'projection') {
  const results = [];
  for (const c of DQ_CHECKS) {
    const r = await q.query<{ violations: number }>(c.sql.replace(/projection\./g, `${schema}.`));
    results.push({ id: c.id, kind: c.kind, description: c.description, violations: Number(r.rows[0]?.violations ?? 0) });
  }
  return { passed: results.every((r) => r.violations === 0), checks: results.length, failed: results.filter((r) => r.violations > 0) };
}

/** Applies a list of changes to in-memory objects (re-exported for the in-memory store). */
export { applyChanges };
