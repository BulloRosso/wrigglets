import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { EventStore, Lake } from '@cw/lake';
import { opaData, genAppSdk, genSdk } from '@cw/ontology-codegen';
import { freshWorld, sofaExtract } from '@cw/sofa-domain';
import { identifierIn } from './runtime.js';
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
  /** Embedded policy engine (status for /health and the console). */
  engine?: { loaded: boolean; revision?: string; loadedAt?: string; lastError?: string };
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
    const rows = d.svc.objects()[String(req.params.class)];
    if (!rows) return void res.status(404).json({ error: `unknown class ${req.params.class}` });
    res.json(rows);
  });
  api.get('/objects/:class/:id', (req, res) => {
    const cls = String(req.params.class);
    const rows = d.svc.objects()[cls];
    const row = rows?.find((r) => String(r[identifierIn(d.svc.ir, cls)]) === String(req.params.id));
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
  internal.post(
    '/shadow/replay',
    wrap(async (req, res) => {
      const b = z
        .object({ windowMs: z.number().int().min(60_000).max(90 * 86_400_000).optional(), fromSeq: z.number().int().min(0).optional(), toSeq: z.number().int().min(0).optional(), candidate: z.record(z.string(), z.unknown()).optional() })
        .parse(req.body ?? {});
      res.json(await d.svc.shadowReplay(b as never));
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
  /** Events after a seq, for the business worker's dispatcher (M5): start/signal workflows from committed events. */
  internal.get(
    '/events',
    wrap(async (req, res) => {
      const after = Math.max(0, Number(req.query.after ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200) || 200));
      res.json({ events: await d.store.readAfter(after, limit), stats: await d.store.stats() });
    }),
  );
  /** Generated OPA data (data.liquid.ontology) for the policy bundle the control plane builds (ADR-0044). */
  internal.get('/opa/data', (_req, res) => res.json(opaData(d.svc.ir)));
  // policy decisions are events (ADR-0049): object-level denials of this core and the gateway's policy decisions
  internal.get(
    '/policy/decisions',
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const r = await d.store.query(`SELECT occurred_at, type, action, actor_agent, actor_user, payload FROM events WHERE type = 'PolicyDecision' OR (type = 'GatewayToolCall' AND payload ? 'policy') ORDER BY seq DESC LIMIT $1`, [limit]);
      res.json(
        r.map((e) => ({
          at: new Date(e.occurred_at as string).toISOString(),
          path: e.type === 'PolicyDecision' ? 'liquid/object/decision' : 'liquid/gateway/decision',
          allow: (e.payload as { allow?: boolean; outcome?: string }).allow ?? (e.payload as { outcome?: string }).outcome !== 'denied',
          reason: (e.payload as { reason?: string; policyReason?: string }).reason ?? (e.payload as { policyReason?: string }).policyReason ?? null,
          obligations: (e.payload as { obligations?: string[] }).obligations ?? [],
          input: { agent: e.actor_agent ?? undefined, action: e.action ?? undefined, tool: (e.payload as { tool?: string }).tool, caller: e.actor_user ?? undefined },
        })),
      );
    }),
  );
  /** Audit as a query over the event log (ADR-0049): types, actor (agent or person), object, text, time, limit. */
  internal.get(
    '/events/query',
    wrap(async (req, res) => {
      const q = (k: string) => (typeof req.query[k] === 'string' && (req.query[k] as string).trim() ? (req.query[k] as string).trim() : undefined);
      const where: string[] = [];
      const params: unknown[] = [];
      const p = (v: unknown) => {
        params.push(v);
        return '$' + params.length;
      };
      if (q('types')) where.push('type = ANY(' + p(q('types')!.split(',').map((x) => x.trim())) + '::text[])');
      if (q('actor')) {
        const ph = p(q('actor'));
        where.push('(actor_agent = ' + ph + ' OR actor_user = ' + ph + ')');
      }
      if (q('object')) {
        const ph = p(q('object'));
        where.push('(object_id = ' + ph + ' OR object_type = ' + ph + ')');
      }
      if (q('q')) where.push('payload::text ILIKE ' + p('%' + q('q') + '%'));
      if (q('since')) where.push('occurred_at >= ' + p(q('since')) + '::timestamptz');
      if (q('before')) where.push('seq < ' + p(Number(q('before'))));
      const limit = Math.min(Number(q('limit') ?? 100) || 100, 500);
      const sql = 'SELECT seq, event_id, type, object_type, object_id, action, actor_agent, actor_user, task_id, workflow_id, occurred_at, ontology_version, payload FROM events ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY seq DESC LIMIT ' + limit;
      const rows = await d.store.query(sql, params);
      const types = await d.store.query<{ type: string; n: number }>('SELECT type, count(*)::int AS n FROM events GROUP BY type ORDER BY n DESC');
      res.json({ events: rows, types });
    }),
  );
  internal.get('/policy/engine', (_req, res) => res.json(d.engine ?? { loaded: false }));
  // core checks of an action without running it, and the shadow replay of a precondition (D3, M10)
  internal.post('/actions/:name/check', (req, res) => res.json(d.svc.checkPreconditions(String(req.params.name), (req.body ?? {}) as Record<string, unknown>)));
  internal.post(
    '/shadow/precondition',
    wrap(async (req, res) => {
      const b = z.object({ action: z.string().min(1), precondition: z.string().min(1), windowMs: z.number().int().min(60_000).max(90 * 86_400_000).optional(), assume: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))).optional() }).parse(req.body ?? {});
      res.json(await d.svc.shadowPrecondition(b));
    }),
  );
  /** Health of the core's part of the control loop (ADR-0051): dispatcher and lake lag, policy engine, ontology. */
  internal.get(
    '/health/loop',
    wrap(async (_req, res) => {
      const st = await d.store.stats();
      const cur = (await d.store.query<Record<string, unknown>>("SELECT seq, updated_at FROM dispatch_cursor WHERE id = 'business'").catch(() => [] as Array<Record<string, unknown>>))[0];
      const lake = await d.lake.status().catch((err: Error) => ({ error: err.message }) as { error: string; hwm?: number; lastFlush?: unknown });
      const eng = d.engine as { revision?: string; loadedAt?: string } | undefined;
      res.json({
        events: { maxSeq: st.maxSeq },
        dispatcher: cur ? { cursor: Number(cur.seq), updatedAt: cur.updated_at, lag: st.maxSeq - Number(cur.seq) } : null,
        lake: { hwm: lake.hwm ?? null, lag: lake.hwm == null ? null : st.maxSeq - lake.hwm, lastFlush: lake.lastFlush ?? null, error: 'error' in lake ? lake.error : null },
        policy: eng?.revision ? { revision: eng.revision, loadedAt: eng.loadedAt } : null,
        ontology: { name: d.svc.ir.name, version: d.svc.ir.version },
      });
    }),
  );
  // ontology evolution (ADR-0048): versions, check and live apply of a new IR, the SDK of the version in force
  internal.get('/ontology/versions', wrap(async (_req, res) => res.json(await d.svc.versions())));
  internal.post('/ontology/check', wrap(async (req, res) => res.json(await d.svc.check(req.body?.ir))));
  internal.post(
    '/ontology/apply',
    wrap(async (req, res) => {
      const b = z.object({ ir: z.unknown(), allowBreaking: z.boolean().optional(), note: z.string().max(4000).optional(), by: z.string().max(200).optional() }).parse(req.body ?? {});
      res.json(await d.svc.apply(b.ir, { allowBreaking: b.allowBreaking, note: b.note, by: b.by }));
    }),
  );
  internal.get('/ontology/sdk.ts', (_req, res) => res.type('text/plain').send(genSdk(d.svc.ir)));
  // the standalone SDK registered apps must use, byte for byte (ADR-0050)
  internal.get('/ontology/app-sdk.ts', (_req, res) => res.type('text/plain').send(genAppSdk(d.svc.ir)));

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
