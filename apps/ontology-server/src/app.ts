import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { EventStore, Lake } from '@cw/lake';
import { freshWorld, identifierAttr, sofaExtract, worldToObjects } from '@cw/sofa-domain';
import { opaData } from '@cw/ontology-sofa';
import { GROUPS, rpc, type Group } from './mcp.js';
import { OntologyService } from './service.js';

/*
 * HTTP surface of the ontology server (ADR-0040, ADR-0043).
 *
 * Agents (through the MCP gateway, bearer MCP_TOKEN):
 *   POST /onto/mcp, /erp/mcp, /crm/mcp     ontology actions as MCP tools (stateless JSON-RPC)
 * Control plane, SDK/UIs and scripted checks (bearer INTERNAL_TOKEN; UIs get OIDC tokens in M9):
 *   GET  /objects/:class[/:id]             current objects from the projection
 *   POST /actions/:name                    run an action (same pipeline as MCP)
 *   GET  /kpi                              business KPI
 *   /internal/sim/{kpi,log,notices,state}  GET   the parity runner's view (same as the mock's /kpi, /log, …)
 *   /internal/sim/reset, /internal/sim/scenario/:id/start   POST   baseline and disruptions — written as events
 *   POST /internal/projection/rebuild[?dryRun=true]   rebuild from T0 + event log, compare, swap
 *   GET  /internal/projection/dq           generated data-quality checks on the projection
 *   /internal/lake/*, GET /internal/ontology, POST /internal/events (test events only; never business data)
 */

export interface AppDeps {
  store: EventStore;
  lake: Lake;
  svc: OntologyService;
  token: string;
  mcpToken: string;
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
const bearer = (token: string): RequestHandler => (req, res, next) => {
  const t = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!safeEqual(t, token)) return void res.status(401).json({ error: 'unauthorized' });
  next();
};
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => void fn(req, res).catch(next);

export function createApp(d: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  const json = express.json({ limit: '2mb' });

  app.get('/health', async (_req, res) => {
    const db = await d.ping().catch(() => false);
    const hwm = await d.lake.hwm().then(
      (v) => v,
      () => undefined,
    );
    res.status(db && hwm !== undefined ? 200 : 503).json({ status: db && hwm !== undefined ? 'ok' : 'degraded', db, lake: hwm !== undefined, hwm, ontology: `${d.svc.ir.name}@${d.svc.ir.version}` });
  });

  /* ---------------------------------------------------------------- MCP (agents via the gateway) */
  for (const g of GROUPS) {
    app.post(
      `/${g}/mcp`,
      bearer(d.mcpToken),
      json,
      wrap(async (req, res) => {
        const msg = req.body as unknown;
        if (Array.isArray(msg)) {
          const out = (await Promise.all(msg.map((m) => rpc(d.svc, g as Group, m)))).filter(Boolean);
          return void (out.length ? res.json(out) : res.status(202).end());
        }
        const out = await rpc(d.svc, g as Group, msg as never);
        if (out) res.json(out);
        else res.status(202).end();
      }),
    );
  }

  /* ---------------------------------------------------------------- REST (SDK, control plane) */
  const api = express.Router();
  api.use(bearer(d.token), json);
  api.get('/objects/:class', (req, res) => {
    const rows = worldToObjects(d.svc.company.W)[String(req.params.class)];
    if (!rows) return void res.status(404).json({ error: `unknown class ${req.params.class}` });
    res.json(rows);
  });
  api.get('/objects/:class/:id', (req, res) => {
    const cls = String(req.params.class);
    const rows = worldToObjects(d.svc.company.W)[cls];
    const row = rows?.find((r) => String(r[identifierAttr(cls)]) === String(req.params.id));
    if (!row) return void res.status(404).json({ error: 'not found' });
    res.json(row);
  });
  api.post(
    '/actions/:name',
    wrap(async (req, res) => {
      const { args, caller } = OntologyService.splitCaller((req.body ?? {}) as Record<string, unknown>);
      const out = await d.svc.execute(String(req.params.name), args, { ...caller, user: req.header('x-requested-by') ?? caller.user });
      res.status(out.denied ? 403 : out.isError ? 422 : 200).json({ ok: !out.isError, result: out.text, seq: out.seq });
    }),
  );
  api.get('/kpi', (_req, res) => res.json(d.svc.company.kpi()));
  app.use(api);

  /* ---------------------------------------------------------------- internal */
  const internal = express.Router();
  internal.use(bearer(d.token), json);

  internal.post(
    '/events',
    wrap(async (req, res) => {
      const body = z.object({ events: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) }).parse(req.body);
      const ontologyEvents = new Set(d.svc.ir.events.map((e) => e.name));
      const bad = body.events.find((e) => ontologyEvents.has(String(e.type)) || (typeof e.payload === 'object' && e.payload !== null && 'changes' in e.payload));
      if (bad) return void res.status(403).json({ error: 'business events are written by actions only (POST /actions/:name or MCP); this endpoint takes test events' });
      res.status(201).json({ results: await d.store.append(body.events as never) });
    }),
  );
  internal.post('/lake/flush', wrap(async (_req, res) => res.json(await d.lake.flush(d.store, { graceMs: d.flushGraceMs }))));
  internal.post(
    '/lake/seed',
    wrap(async (req, res) => {
      const { source } = z.object({ source: z.enum(Object.keys(SEEDS) as [keyof typeof SEEDS]) }).parse(req.body ?? {});
      const s = SEEDS[source];
      res.json({ extractId: s.extractId, ...(await d.lake.writeExtract(s.extractId, s.source, s.tables())) });
    }),
  );
  internal.get('/lake/status', wrap(async (_req, res) => res.json({ ...(await d.lake.status()), files: await d.lake.files(), eventLog: await d.store.stats() })));
  internal.get('/lake/counts', wrap(async (req, res) => res.json(await d.lake.counts(typeof req.query.extract === 'string' ? req.query.extract : undefined))));
  internal.post(
    '/lake/query',
    wrap(async (req, res) => {
      const { sql } = z.object({ sql: z.string().min(1).max(10_000) }).parse(req.body);
      res.json({ rows: await d.lake.query(sql) });
    }),
  );
  internal.get('/ontology', (_req, res) => res.json(d.svc.ir));
  /** Generated OPA data (data.liquid.ontology) for the policy bundle the control plane builds (ADR-0044). */
  internal.get('/opa/data', (_req, res) => res.json(opaData()));

  // parity runner (the mock's control surface)
  internal.get('/sim/kpi', (_req, res) => res.json(d.svc.company.kpi()));
  internal.get('/sim/log', wrap(async (_req, res) => res.json(await d.svc.writeLog())));
  internal.get('/sim/notices', (_req, res) => res.json(d.svc.company.W.customerNotices));
  internal.get('/sim/state', (_req, res) => res.json({ events: d.svc.company.W.events, kpi: d.svc.company.kpi(), writtenOffEur: d.svc.company.W.writtenOffEur ?? 0 }));
  internal.post('/sim/reset', wrap(async (_req, res) => res.json(await d.svc.reset())));
  internal.post(
    '/sim/scenario/:id/start',
    wrap(async (req, res) => {
      try {
        res.json(await d.svc.scenario(String(req.params.id)));
      } catch (e) {
        const err = e as Error & { status?: number; known?: readonly string[] };
        if (err.status === 404) return void res.status(404).json({ error: 'unknown scenario', known: err.known });
        throw e;
      }
    }),
  );
  internal.post('/projection/rebuild', wrap(async (req, res) => res.json(await d.svc.rebuild({ dryRun: req.query.dryRun === 'true' }))));
  internal.get('/projection/dq', wrap(async (_req, res) => res.json(await d.svc.dq())));
  app.use('/internal', internal);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return void res.status(400).json({ error: 'invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const message = err instanceof Error ? err.message : String(err);
    res.status(/only a single SELECT/.test(message) ? 400 : 500).json({ error: message });
  });
  return app;
}
