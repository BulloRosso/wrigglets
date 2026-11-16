import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { contiguousBatch, type EventStore, type StoredEvent } from './events.js';

/*
 * The open-format copy of the business data (ADR-0040): a DuckLake database whose catalog lives in Postgres (schema
 * lake_catalog of the ontology DB) and whose data are Parquet files on a volume. DuckDB 2 is embedded in the process;
 * the ducklake and postgres extensions are installed at image build time (no downloads at runtime in production).
 *
 * Schema raw: raw.events (the flushed event log) and raw.erp_* / raw.crm_* (source system extracts), plus
 * raw._extracts (one row per extract). Raw data is never updated; a new extract is a new set of rows.
 */

export type RawColumnType = 'VARCHAR' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'JSON' | 'TIMESTAMPTZ';
export interface RawTable {
  name: string;
  key: string[];
  columns: Array<{ name: string; type: RawColumnType }>;
  rows: Array<Record<string, string | number | boolean | null>>;
}

export interface LakeOptions {
  /**
   * DuckLake catalog: `postgres:dbname=onto host=ontology-db user=onto password=…` in production, or a file path
   * (a DuckDB-file catalog) in tests.
   */
  catalog: string;
  /** Directory of the Parquet files (must end with a slash). */
  dataPath: string;
  /** Postgres schema of the catalog tables (only for a postgres catalog). */
  metadataSchema?: string;
  /** Allow DuckDB to download extensions (tests / development). Production images have them preinstalled. */
  autoInstall?: boolean;
}

const NAME = /^_?[a-z][a-z0-9_]{0,62}$/;
const ident = (s: string) => {
  if (!NAME.test(s)) throw new Error(`invalid identifier ${s}`);
  return s;
};
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const CHUNK = 400;

const EVENT_COLUMNS: RawTable['columns'] = [
  { name: 'seq', type: 'BIGINT' },
  { name: 'event_id', type: 'VARCHAR' },
  { name: 'type', type: 'VARCHAR' },
  { name: 'object_type', type: 'VARCHAR' },
  { name: 'object_id', type: 'VARCHAR' },
  { name: 'action', type: 'VARCHAR' },
  { name: 'actor_agent', type: 'VARCHAR' },
  { name: 'actor_user', type: 'VARCHAR' },
  { name: 'task_id', type: 'VARCHAR' },
  { name: 'workflow_id', type: 'VARCHAR' },
  { name: 'payload', type: 'JSON' },
  { name: 'occurred_at', type: 'TIMESTAMPTZ' },
  { name: 'recorded_at', type: 'TIMESTAMPTZ' },
  { name: 'ontology_version', type: 'VARCHAR' },
];

/** Serialises access to the single DuckDB connection (DuckDB connections are not meant for concurrent statements). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface FlushResult {
  flushed: number;
  hwm: number;
  /** Events newer than the high-water mark that were held back by a young gap. */
  waiting: number;
}

export class Lake {
  private readonly lock = new Mutex();
  private lastFlush?: { at: string; result: FlushResult };

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly c: DuckDBConnection,
  ) {}

  static async open(o: LakeOptions): Promise<Lake> {
    const instance = await DuckDBInstance.create(':memory:', o.autoInstall ? {} : { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' });
    const c = await instance.connect();
    if (o.autoInstall) await c.run('INSTALL ducklake; INSTALL postgres;');
    await c.run('LOAD ducklake;');
    if (o.catalog.startsWith('postgres:')) await c.run('LOAD postgres;');
    // DATA_INLINING_ROW_LIMIT 0: DuckLake would otherwise keep small inserts inside the catalog database; the raw zone
    // must be Parquet files (open format, readable without the catalog).
    const opts = [`DATA_PATH ${lit(o.dataPath)}`, 'DATA_INLINING_ROW_LIMIT 0', ...(o.metadataSchema ? [`METADATA_SCHEMA ${lit(o.metadataSchema)}`] : [])];
    await c.run(`ATTACH ${lit(`ducklake:${o.catalog}`)} AS lake (${opts.join(', ')})`);
    // Move data that an older catalog version inlined into Parquet files (no-op when there is none).
    await c.run("CALL ducklake_flush_inlined_data('lake')");
    const lake = new Lake(instance, c);
    await lake.ensureSchema();
    return lake;
  }

  private async ensureSchema() {
    await this.c.run('CREATE SCHEMA IF NOT EXISTS lake.raw');
    await this.c.run(`CREATE TABLE IF NOT EXISTS lake.raw.events (${EVENT_COLUMNS.map((c) => `${c.name} ${c.type}`).join(', ')})`);
    await this.c.run('CREATE TABLE IF NOT EXISTS lake.raw._extracts (extract_id VARCHAR, source VARCHAR, extracted_at TIMESTAMPTZ, tables JSON)');
  }

  close() {
    this.c.closeSync();
    this.instance.closeSync();
  }

  private async rows(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> {
    const r = await this.c.runAndReadAll(sql, params as never);
    return r.getRowObjectsJson() as Array<Record<string, unknown>>;
  }

  /** Inserts rows into a lake table with one INSERT … SELECT, so a batch becomes one snapshot. */
  private async insert(table: string, columns: RawTable['columns'], rows: RawTable['rows'], extra: Record<string, string> = {}) {
    if (!rows.length) return;
    const stage = `stage_${ident(table.replace(/^_/, 'x'))}`;
    const all = [...columns, ...Object.keys(extra).map((name) => ({ name, type: 'VARCHAR' as const }))];
    await this.c.run(`CREATE OR REPLACE TEMP TABLE ${stage} (${all.map((c) => `${ident(c.name)} ${c.type}`).join(', ')})`);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const tuples = chunk.map((r) => `(${all.map((c) => (params.push(c.name in extra ? extra[c.name] : (r[c.name] ?? null)), `$${params.length}::${c.type}`)).join(', ')})`);
      await this.c.run(`INSERT INTO ${stage} VALUES ${tuples.join(', ')}`, params as never);
    }
    await this.c.run(`INSERT INTO lake.raw.${ident(table)} SELECT * FROM ${stage}`);
    await this.c.run(`DROP TABLE ${stage}`);
  }

  /** Highest event seq already in the lake (0 when empty). */
  async hwm(): Promise<number> {
    return this.lock.run(async () => Number((await this.rows('SELECT coalesce(max(seq), 0)::BIGINT AS m FROM lake.raw.events'))[0]?.m ?? 0));
  }

  /**
   * Appends the events after the lake's high-water mark (idempotent by seq: running it twice adds nothing).
   * Stops at a gap that may still be filled by a transaction in flight (see contiguousBatch).
   */
  async flush(store: Pick<EventStore, 'readAfter'>, opts: { batch?: number; graceMs?: number; now?: number } = {}): Promise<FlushResult> {
    return this.lock.run(async () => {
      let hwm = Number((await this.rows('SELECT coalesce(max(seq), 0)::BIGINT AS m FROM lake.raw.events'))[0]?.m ?? 0);
      let flushed = 0;
      let waiting = 0;
      for (;;) {
        const rows = await store.readAfter(hwm, opts.batch ?? 1000);
        if (!rows.length) break;
        const batch = contiguousBatch(rows, hwm, opts.now ?? Date.now(), opts.graceMs ?? 60_000);
        waiting = rows.length - batch.length;
        if (!batch.length) break;
        await this.insert('events', EVENT_COLUMNS, batch.map(eventRow));
        flushed += batch.length;
        hwm = batch.at(-1)!.seq;
        if (waiting) break;
      }
      const result = { flushed, hwm, waiting };
      this.lastFlush = { at: new Date().toISOString(), result };
      return result;
    });
  }

  /**
   * Writes a source system extract (e.g. the sofa company at T0) as raw tables, in one transaction. Idempotent by
   * extract id: a second call with the same id writes nothing and returns `written: false`.
   */
  async writeExtract(extractId: string, source: string, tables: RawTable[]): Promise<{ written: boolean; counts: Record<string, number> }> {
    return this.lock.run(async () => {
      const counts = Object.fromEntries(tables.map((t) => [t.name, t.rows.length]));
      const seen = await this.rows('SELECT count(*)::INT AS n FROM lake.raw._extracts WHERE extract_id = $1', [extractId]);
      if (Number(seen[0]?.n) > 0) return { written: false, counts };
      const at = new Date().toISOString();
      await this.c.run('BEGIN TRANSACTION');
      try {
        for (const t of tables) {
          if (t.name === 'events' || t.name.startsWith('_')) throw new Error(`reserved table name ${t.name}`);
          const cols = [...t.columns.map((c) => `${ident(c.name)} ${c.type}`), '_extract_id VARCHAR', '_extracted_at VARCHAR'];
          await this.c.run(`CREATE TABLE IF NOT EXISTS lake.raw.${ident(t.name)} (${cols.join(', ')})`);
          await this.insert(t.name, t.columns, t.rows, { _extract_id: extractId, _extracted_at: at });
        }
        await this.c.run('INSERT INTO lake.raw._extracts VALUES ($1, $2, $3::TIMESTAMPTZ, $4::JSON)', [extractId, source, at, JSON.stringify(counts)] as never);
        await this.c.run('COMMIT');
      } catch (err) {
        await this.c.run('ROLLBACK').catch(() => undefined);
        throw err;
      }
      return { written: true, counts };
    });
  }

  /** Rows of a raw table from one extract, in key order, with the declared column types restored for JSON. */
  async readExtract(extractId: string, table: Pick<RawTable, 'name' | 'key' | 'columns'>): Promise<RawTable['rows']> {
    return this.lock.run(async () => {
      const sel = table.columns.map((c) => {
        const n = ident(c.name);
        if (c.type === 'BIGINT') return `${n}::DOUBLE AS ${n}`;
        if (c.type === 'DATE') return `strftime(${n}, '%Y-%m-%d') AS ${n}`;
        if (c.type === 'JSON') return `${n}::VARCHAR AS ${n}`;
        return n;
      });
      return (await this.rows(`SELECT ${sel.join(', ')} FROM lake.raw.${ident(table.name)} WHERE _extract_id = $1 ORDER BY ${table.key.map(ident).join(', ')}`, [extractId])) as RawTable['rows'];
    });
  }

  /** Number of Parquet data files per raw table (every non-empty table must have at least one). */
  async files(): Promise<Record<string, number>> {
    return this.lock.run(async () => {
      const tables = (await this.rows("SELECT table_name AS t FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = 'raw' ORDER BY 1")).map((r) => String(r.t));
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = Number((await this.rows(`SELECT count(*)::INT AS n FROM ducklake_list_files('lake', ${lit(ident(t))}, schema => 'raw')`))[0]?.n ?? 0);
      return out;
    });
  }

  /** Row count per raw table (optionally of one extract); raw.events counts all flushed events. */
  async counts(extractId?: string): Promise<Record<string, number>> {
    return this.lock.run(async () => {
      const tables = (await this.rows("SELECT table_name AS t FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = 'raw' ORDER BY 1")).map((r) => String(r.t));
      const out: Record<string, number> = {};
      for (const t of tables) {
        if (t === '_extracts') continue;
        const where = extractId && t !== 'events' ? ' WHERE _extract_id = $1' : '';
        out[t] = Number((await this.rows(`SELECT count(*)::BIGINT AS n FROM lake.raw.${ident(t)}${where}`, where ? [extractId] : undefined))[0]?.n ?? 0);
      }
      return out;
    });
  }

  async status() {
    return this.lock.run(async () => {
      const snaps = await this.rows("SELECT count(*)::INT AS n, max(snapshot_time)::VARCHAR AS last FROM ducklake_snapshots('lake')");
      const extracts = await this.rows('SELECT extract_id, source, extracted_at::VARCHAR AS extracted_at, tables::VARCHAR AS tables FROM lake.raw._extracts ORDER BY extracted_at');
      const hwm = Number((await this.rows('SELECT coalesce(max(seq), 0)::BIGINT AS m FROM lake.raw.events'))[0]?.m ?? 0);
      return {
        hwm,
        snapshots: Number(snaps[0]?.n ?? 0),
        lastSnapshotAt: (snaps[0]?.last as string | null) ?? null,
        extracts: extracts.map((e) => ({ id: String(e.extract_id), source: String(e.source), at: String(e.extracted_at), tables: JSON.parse(String(e.tables)) as Record<string, number> })),
        lastFlush: this.lastFlush ?? null,
      };
    });
  }

  /** Read-only SQL over the lake (SELECT / WITH only), for diagnostics and the exit checks. */
  async query(sql: string): Promise<Array<Record<string, unknown>>> {
    if (!/^\s*(select|with)\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('only a single SELECT is allowed');
    return this.lock.run(() => this.rows(sql));
  }
}

const eventRow = (e: StoredEvent): RawTable['rows'][number] => ({
  seq: e.seq,
  event_id: e.eventId,
  type: e.type,
  object_type: e.objectType,
  object_id: e.objectId,
  action: e.action,
  actor_agent: e.actorAgent,
  actor_user: e.actorUser,
  task_id: e.taskId,
  workflow_id: e.workflowId,
  payload: JSON.stringify(e.payload),
  occurred_at: e.occurredAt,
  recorded_at: e.recordedAt,
  ontology_version: e.ontologyVersion,
});
