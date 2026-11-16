import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { EventStore, Lake } from '@cw/lake';
import { freshWorld, sofaExtract } from '@cw/sofa-domain';
import { loadIr } from '@cw/ontology-sofa';

/*
 * HTTP surface of the ontology server, M1 part (ADR-0040). Everything under /internal is for the control plane and the
 * scripted checks (bearer INTERNAL_TOKEN); agents never reach it: they get ontology tools through the gateway (M3).
 *
 *   GET  /health                         liveness + database and lake reachability
 *   POST /internal/events                append events { events: EventInput[] } (M3: only the action pipeline writes)
 *   POST /internal/lake/flush            flush the event log into lake.raw.events now
 *   POST /internal/lake/seed             write a source system extract { source: "sofa" } (idempotent by extract id)
 *   GET  /internal/lake/status           high-water mark, snapshots, extracts, last flush, event log stats
 *   GET  /internal/lake/counts?extract=  rows per raw table
 *   POST /internal/lake/query            read-only SQL { sql } (single SELECT)
 *   GET  /internal/ontology              the compiled ontology IR this server runs on (M2; the editor reads it)
 */

export interface AppDeps {
  store: EventStore;
  lake: Lake;
  token: string;
  ping: () => Promise<boolean>;
  flushGraceMs: number;
}

export const SEEDS = {
  sofa: { extractId: 'sofa-T0', source: 'sofa-company mock (scripts/sofa-company/mock-mcp.mjs), initial state', tables: () => sofaExtract(freshWorld().world) },
} as const;

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(d: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', async (_req, res) => {
    const db = await d.ping().catch(() => false);
    const hwm = await d.lake.hwm().then(
      (v) => v,
      () => undefined,
    );
    res.status(db && hwm !== undefined ? 200 : 503).json({ status: db && hwm !== undefined ? 'ok' : 'degraded', db, lake: hwm !== undefined, hwm });
  });

  const internal = express.Router();
  internal.use((req, res, next) => {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!safeEqual(token, d.token)) return void res.status(401).json({ error: 'unauthorized' });
    next();
  });
  internal.use(express.json({ limit: '2mb' }));

  internal.post('/events', async (req, res) => {
    const body = z.object({ events: z.array(z.unknown()).min(1).max(5000) }).parse(req.body);
    res.status(201).json({ results: await d.store.append(body.events as never) });
  });
  internal.post('/lake/flush', async (_req, res) => res.json(await d.lake.flush(d.store, { graceMs: d.flushGraceMs })));
  internal.post('/lake/seed', async (req, res) => {
    const { source } = z.object({ source: z.enum(Object.keys(SEEDS) as [keyof typeof SEEDS]) }).parse(req.body ?? {});
    const s = SEEDS[source];
    res.json({ extractId: s.extractId, ...(await d.lake.writeExtract(s.extractId, s.source, s.tables())) });
  });
  internal.get('/lake/status', async (_req, res) => res.json({ ...(await d.lake.status()), files: await d.lake.files(), eventLog: await d.store.stats() }));
  internal.get('/lake/counts', async (req, res) => res.json(await d.lake.counts(typeof req.query.extract === 'string' ? req.query.extract : undefined)));
  internal.post('/lake/query', async (req, res) => {
    const { sql } = z.object({ sql: z.string().min(1).max(10_000) }).parse(req.body);
    res.json({ rows: await d.lake.query(sql) });
  });
  internal.get('/ontology', (_req, res) => res.json(loadIr()));
  app.use('/internal', internal);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return void res.status(400).json({ error: 'invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const message = err instanceof Error ? err.message : String(err);
    res.status(/only a single SELECT/.test(message) ? 400 : 500).json({ error: message });
  });
  return app;
}
