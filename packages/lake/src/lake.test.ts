import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshWorld, sofaExtract } from '@cw/sofa-domain';
import { EventStore, contiguousBatch, type SqlClient } from './events.js';
import { Lake } from './lake.js';

/*
 * Runs without Docker: PGlite (Postgres in WebAssembly) for the event log, and a DuckDB-file catalog for DuckLake
 * (production uses the Postgres catalog; the DuckLake behaviour under test is the same). The first run downloads the
 * ducklake extension into the local DuckDB extension directory.
 */

let pg: PGlite;
let store: EventStore;
let dir: string;
let lake: Lake;

const client = (db: PGlite): SqlClient => ({
  query: async <T>(text: string, params?: unknown[]) => {
    // PGlite runs one statement per query() with parameters; multi-statement DDL goes through exec()
    if (!params?.length && text.split(';').filter((s) => s.trim()).length > 1) {
      await db.exec(text);
      return { rows: [] as T[] };
    }
    return (await db.query<T>(text, params)) as { rows: T[] };
  },
});

beforeAll(async () => {
  pg = new PGlite();
  store = new EventStore(client(pg));
  await store.migrate();
});
afterAll(async () => pg.close());

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lake-'));
  lake = await Lake.open({ catalog: path.join(dir, 'catalog.ducklake'), dataPath: `${path.join(dir, 'data').replace(/\\/g, '/')}/`, autoInstall: true });
  await pg.exec('ALTER TABLE events DISABLE TRIGGER events_no_truncate; TRUNCATE events RESTART IDENTITY; ALTER TABLE events ENABLE TRIGGER events_no_truncate;');
});
afterEach(async () => {
  lake.close();
  await rm(dir, { recursive: true, force: true });
});

const ev = (i: number) => ({ type: 'TestHappened', objectType: 'Thing', objectId: `T-${i}`, payload: { i }, ontologyVersion: '0.1.0' });

describe('event store', () => {
  it('appends events with increasing seq and is idempotent by event id', async () => {
    const id = '7b0c3f2e-8a9d-4e61-9f0a-1c2d3e4f5a6b';
    const first = await store.append([{ ...ev(1), eventId: id }, ev(2)]);
    expect(first.map((r) => [r.seq, r.duplicate])).toEqual([
      [1, false],
      [2, false],
    ]);
    const again = await store.append([{ ...ev(1), eventId: id }]);
    expect(again).toEqual([{ eventId: id, seq: 1, duplicate: true }]);
    expect(await store.stats()).toEqual({ count: 2, maxSeq: 2 });
    const read = await store.readAfter(0);
    expect(read[0]).toMatchObject({ seq: 1, eventId: id, type: 'TestHappened', objectType: 'Thing', objectId: 'T-1', payload: { i: 1 }, ontologyVersion: '0.1.0' });
  });

  it('rejects invalid events before writing anything', async () => {
    await expect(store.append([ev(1), { ...ev(2), type: 'not pascal' }])).rejects.toThrow();
    expect((await store.stats()).count).toBe(0);
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE fail', async () => {
    await store.append([ev(1)]);
    await expect(pg.query("UPDATE events SET type = 'X'")).rejects.toThrow(/append-only/);
    await expect(pg.query('DELETE FROM events')).rejects.toThrow(/append-only/);
    await expect(pg.query('TRUNCATE events')).rejects.toThrow(/append-only/);
    expect((await store.stats()).count).toBe(1);
  });
});

describe('contiguous batch', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const row = (seq: number, agoMs: number) => ({ seq, recordedAt: new Date(now - agoMs).toISOString() });

  it.each([
    ['no gap', [row(1, 0), row(2, 0), row(3, 0)], 0, [1, 2, 3]],
    ['starts after the high-water mark', [row(5, 0), row(6, 0)], 4, [5, 6]],
    ['stops at a young gap (transaction may still commit)', [row(1, 0), row(3, 1_000)], 0, [1]],
    ['skips an old gap (rolled back)', [row(1, 0), row(3, 120_000), row(4, 0)], 0, [1, 3, 4]],
    ['young gap right after the mark: nothing', [row(2, 5_000)], 0, []],
    ['ignores rows at or below the mark', [row(3, 0), row(4, 0)], 3, [4]],
  ])('%s', (_n, rows, hwm, seqs) => {
    expect(contiguousBatch(rows, hwm, now, 60_000).map((r) => r.seq)).toEqual(seqs);
  });
});

describe('flush to the lake', () => {
  it('1,000 events flushed twice yield exactly 1,000 rows (exit criterion)', async () => {
    for (let i = 0; i < 1000; i += 250) await store.append(Array.from({ length: 250 }, (_, k) => ev(i + k)));
    const first = await lake.flush(store);
    expect(first).toMatchObject({ flushed: 1000, hwm: 1000, waiting: 0 });
    const second = await lake.flush(store);
    expect(second).toMatchObject({ flushed: 0, hwm: 1000 });
    expect((await lake.counts()).events).toBe(1000);
    const [r] = await lake.query("SELECT count(DISTINCT seq)::INT AS n, min(seq)::INT AS lo, max(seq)::INT AS hi, count(*) FILTER (WHERE payload->>'i' IS NULL)::INT AS bad FROM lake.raw.events");
    expect(r).toEqual({ n: 1000, lo: 1, hi: 1000, bad: 0 });
  });

  it('continues after the high-water mark with new events', async () => {
    await store.append([ev(1), ev(2)]);
    await lake.flush(store);
    await store.append([ev(3)]);
    expect(await lake.flush(store)).toMatchObject({ flushed: 1, hwm: 3 });
    expect(await lake.hwm()).toBe(3);
  });

  it('keeps event fields intact', async () => {
    await store.append([{ ...ev(7), action: 'create_purchase_order', actorAgent: 'sofa-lara', taskId: 'task-1', occurredAt: '2026-10-05T08:00:00.000Z' }]);
    await lake.flush(store);
    const [r] = await lake.query("SELECT object_id, action, actor_agent, task_id, strftime(occurred_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M') AS at FROM lake.raw.events");
    expect(r).toEqual({ object_id: 'T-7', action: 'create_purchase_order', actor_agent: 'sofa-lara', task_id: 'task-1', at: '2026-10-05T08:00' });
  });

  it('only allows a single SELECT through query()', async () => {
    await expect(lake.query('DROP TABLE lake.raw.events')).rejects.toThrow(/SELECT/);
    await expect(lake.query('SELECT 1; DROP TABLE lake.raw.events')).rejects.toThrow(/SELECT/);
  });
});

describe('seed: source system extract', () => {
  it('round trip: state in → raw tables → read back equal, idempotent by extract id', async () => {
    const tables = sofaExtract(freshWorld().world);
    const res = await lake.writeExtract('sofa-T0', 'sofa-company mock', tables);
    expect(res.written).toBe(true);
    for (const t of tables) {
      const back = await lake.readExtract('sofa-T0', t);
      const sorted = [...t.rows].sort((a, b) => t.key.map((k) => String(a[k]).localeCompare(String(b[k]))).find((x) => x !== 0) ?? 0);
      expect(back, t.name).toEqual(sorted);
    }
    // open format: every non-empty table is stored as Parquet, nothing stays inlined in the catalog
    const files = await lake.files();
    for (const tb of tables) if (tb.rows.length) expect(files[tb.name], tb.name).toBeGreaterThan(0);
    const counts = await lake.counts('sofa-T0');
    for (const t of tables) expect(counts[t.name], t.name).toBe(t.rows.length);
    expect((await lake.writeExtract('sofa-T0', 'again', tables)).written).toBe(false);
    expect((await lake.counts('sofa-T0')).erp_suppliers).toBe(7);
    const st = await lake.status();
    expect(st.extracts).toEqual([expect.objectContaining({ id: 'sofa-T0', source: 'sofa-company mock' })]);
    expect(st.snapshots).toBeGreaterThan(1);
  });

  it('time travel: an earlier snapshot does not see later events', async () => {
    await store.append([ev(1)]);
    await lake.flush(store);
    const [{ v }] = (await lake.query("SELECT max(snapshot_id)::INT AS v FROM ducklake_snapshots('lake')")) as Array<{ v: number }>;
    await store.append([ev(2)]);
    await lake.flush(store);
    const [then] = await lake.query(`SELECT count(*)::INT AS n FROM lake.raw.events AT (VERSION => ${v})`);
    expect(then).toEqual({ n: 1 });
  });
});
