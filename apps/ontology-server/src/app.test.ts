import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventStore, Lake } from '@cw/lake';
import { extractCounts, freshWorld, sofaExtract } from '@cw/sofa-domain';
import { createApp } from './app.js';

const TOKEN = 'test-internal-token-0123456789';
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const pg = new PGlite();
  const store = new EventStore({
    query: async <T>(text: string, params?: unknown[]) => {
      if (!params?.length && text.split(';').filter((s) => s.trim()).length > 1) {
        await pg.exec(text);
        return { rows: [] as T[] };
      }
      return (await pg.query<T>(text, params)) as { rows: T[] };
    },
  });
  await store.migrate();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'onto-'));
  const lake = await Lake.open({ catalog: path.join(dir, 'c.ducklake'), dataPath: `${path.join(dir, 'data').replace(/\\/g, '/')}/`, autoInstall: true });
  const server = createApp({ store, lake, token: TOKEN, ping: async () => true, flushGraceMs: 60_000 }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise((r) => server.close(r));
    lake.close();
    await pg.close();
    await rm(dir, { recursive: true, force: true });
  };
});
afterAll(async () => close());

const call = (method: string, p: string, body?: unknown, token = TOKEN) =>
  fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('ontology server (M1)', () => {
  it('reports health', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'ok', db: true, lake: true });
  });

  it('rejects internal calls without the token', async () => {
    expect((await call('GET', '/internal/lake/status', undefined, 'wrong')).status).toBe(401);
  });

  it('appends events, flushes them into the lake and reports the status', async () => {
    const ev = { type: 'SupplierNoticeIssued', objectType: 'Supplier', objectId: 'S-NORDHOLZ', payload: { until: '2026-11-30' } };
    const a = await call('POST', '/internal/events', { events: [ev, ev] });
    expect(a.status).toBe(201);
    expect(((await a.json()) as { results: unknown[] }).results).toHaveLength(2);
    expect(await (await call('POST', '/internal/lake/flush')).json()).toMatchObject({ flushed: 2, hwm: 2 });
    const st = (await (await call('GET', '/internal/lake/status')).json()) as { hwm: number; eventLog: { count: number } };
    expect(st).toMatchObject({ hwm: 2, eventLog: { count: 2, maxSeq: 2 } });
  });

  it('seeds the sofa extract once; counts match the mock initial state', async () => {
    const first = (await (await call('POST', '/internal/lake/seed', { source: 'sofa' })).json()) as { written: boolean };
    expect(first.written).toBe(true);
    const again = (await (await call('POST', '/internal/lake/seed', { source: 'sofa' })).json()) as { written: boolean };
    expect(again.written).toBe(false);
    const counts = (await (await call('GET', '/internal/lake/counts?extract=sofa-T0')).json()) as Record<string, number>;
    const { events: _e, ...raw } = counts;
    expect(raw).toEqual(extractCounts(sofaExtract(freshWorld().world)));
  });

  it('validates input and allows only SELECT queries', async () => {
    expect((await call('POST', '/internal/events', { events: [{ type: 'bad type' }] })).status).toBe(400);
    expect((await call('POST', '/internal/lake/seed', { source: 'nope' })).status).toBe(400);
    expect((await call('POST', '/internal/lake/query', { sql: 'DELETE FROM lake.raw.events' })).status).toBe(400);
    const q = (await (await call('POST', '/internal/lake/query', { sql: "SELECT count(*)::INT AS n FROM lake.raw.erp_suppliers WHERE rating = 'A'" })).json()) as { rows: unknown[] };
    expect(q.rows).toEqual([{ n: 5 }]);
  });
});
