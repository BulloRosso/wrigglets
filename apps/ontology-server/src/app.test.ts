import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventStore, Lake } from '@cw/lake';
import { extractCounts, freshWorld, sofaExtract } from '@cw/sofa-domain';
import { loadIr } from '@cw/ontology-sofa';
import type pg from 'pg';
import { createApp } from './app.js';
import { OntologyService } from './service.js';

const TOKEN = 'test-internal-token-0123456789';
const MCP = 'test-mcp-token-0123456789abcdef';
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const pg = new PGlite({ parsers: { 1082: (v: string) => v, 20: (v: string) => Number(v), 1184: (v: string) => new Date(v).toISOString(), 701: (v: string) => Number(v) } });
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
  const q = async (text: string, params?: unknown[]) => {
    if (!params?.length && text.split(';').filter((x) => x.trim()).length > 1) {
      await pg.exec(text);
      return { rows: [] };
    }
    return pg.query(text, params);
  };
  const svc = new OntologyService({ query: q, connect: async () => ({ query: q, release: () => undefined }) } as unknown as pg.Pool, loadIr());
  await svc.init();
  const server = createApp({ store, lake, svc, token: TOKEN, mcpToken: MCP, ping: async () => true, flushGraceMs: 60_000 }).listen(0);
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

describe('ontology server (M3)', () => {
  it('business events cannot bypass the action pipeline', async () => {
    const r = await call('POST', '/internal/events', { events: [{ type: 'PurchaseOrderCreated', objectType: 'PurchaseOrder', objectId: 'PO-1' }] });
    expect(r.status).toBe(403);
    const r2 = await call('POST', '/internal/events', { events: [{ type: 'X1', objectType: 'Y', objectId: 'z', payload: { changes: [] } }] });
    expect(r2.status).toBe(403);
  });
  it('MCP needs the gateway token; REST runs actions through the pipeline', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await fetch(`${base}/erp/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(list) })).status).toBe(401);
    const ok = (await (await fetch(`${base}/erp/mcp`, { method: 'POST', headers: { authorization: `Bearer ${MCP}`, 'content-type': 'application/json' }, body: JSON.stringify(list) })).json()) as { result: { tools: unknown[] } };
    expect(ok.result.tools).toHaveLength(23);
    const act = await call('POST', '/actions/update_campaign', { campaignId: 'CMP-HERBST', dailyBudgetPct: 50 });
    expect(act.status).toBe(200);
    expect(((await act.json()) as { seq: number }).seq).toBeGreaterThan(0);
    const bad = await call('POST', '/actions/update_campaign', { campaignId: 'CMP-NOPE' });
    expect(bad.status).toBe(422);
    const po = (await (await call('GET', '/objects/Campaign/CMP-HERBST')).json()) as { daily_budget_pct: number };
    expect(po.daily_budget_pct).toBe(50);
  });
});

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
    expect(await (await call('POST', '/internal/lake/flush')).json()).toMatchObject({ flushed: 3, hwm: 3 }) // 1 action event of the M3 test + 2 test events;
    const st = (await (await call('GET', '/internal/lake/status')).json()) as { hwm: number; eventLog: { count: number } };
    expect(st).toMatchObject({ hwm: 3, eventLog: { count: 3, maxSeq: 3 } });
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
