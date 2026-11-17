import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { HttpError } from '../agents.js';
import { requireExtension } from './api.js';
import { LIQUID_ID, ontologyCall } from './liquid.js';
import type { ExtensionService } from './service.js';
import type { LiquidPolicyService } from './liquidPolicy.js';
import type { LiquidProcesses } from './liquidProcesses.js';

/* Admin console routes of Liquid Enterprise (Platform.Admin); 404 while the extension is not available. */

interface Audit {
  write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void>;
}

export function liquidAdminRouter(ext: ExtensionService, audit?: Audit, by: (req: Request) => string = () => 'admin', policy?: LiquidPolicyService, processes?: LiquidProcesses): Router {
  const r = Router();
  const ctx = {
    url: (service: string) => ext.url(LIQUID_ID, service),
    secret: (name: string) => {
      const v = ext.secret(LIQUID_ID, name);
      if (!v) throw new HttpError(503, `liquid secret ${name} is missing`);
      return v;
    },
  };
  const call = <T>(method: string, path: string, body?: unknown) =>
    ontologyCall<T>(ctx, method, path, body).catch((err: Error) => {
      throw err instanceof HttpError ? err : new HttpError(502, err.message);
    });
  const pass = (method: string, path: (req: Request) => string, auditAction?: string): RequestHandler => async (req, res, next) => {
    try {
      const out = await call<unknown>(method, path(req), method === 'POST' ? (req.body ?? {}) : undefined);
      if (auditAction && audit) await audit.write({ by: by(req), action: auditAction, target: path(req) });
      res.json(out);
    } catch (err) {
      next(err);
    }
  };

  r.use('/liquid', requireExtension(ext, LIQUID_ID));
  /** Event log and lake: high-water mark, snapshots, extracts, last flush, row counts. */
  r.get('/liquid/lake', async (_req, res, next) => {
    try {
      const [status, counts] = await Promise.all([call<Record<string, unknown>>('GET', '/internal/lake/status'), call<Record<string, number>>('GET', '/internal/lake/counts')]);
      res.json({ ...status, counts });
    } catch (err) {
      next(err);
    }
  });
  /** The compiled ontology (IR) the ontology server runs on; the editor's graph is built from it. */
  r.get('/liquid/ontology', pass('GET', () => '/internal/ontology'));
  /** Ontology versions applied to the ontology server (M8) and the SDK generated from the version in force. */
  r.get('/liquid/ontology/versions', pass('GET', () => '/internal/ontology/versions'));
  /** Audit is a query over the event log (ADR-0049): filter by type, actor, object, text. */
  r.get('/liquid/events', pass('GET', (req) => `/internal/events/query?${new URLSearchParams(Object.entries(req.query).filter(([, v]) => typeof v === 'string') as Array<[string, string]>).toString()}`));
  r.get('/liquid/ontology/sdk', async (req, res, next) => {
    try {
      // ?kind=app: the standalone SDK for registered apps (ADR-0050); default: the SDK for server-side code
      const file = req.query.kind === 'app' ? 'app-sdk.ts' : 'sdk.ts';
      const out = await fetch(`${ctx.url('ontology-server')}/internal/ontology/${file}`, { headers: { authorization: `Bearer ${ctx.secret('ontology_internal_token')}` }, signal: AbortSignal.timeout(20_000) });
      if (!out.ok) throw new HttpError(502, `ontology server: HTTP ${out.status}`);
      res.type('text/plain').send(await out.text());
    } catch (err) {
      next(err);
    }
  });

  // Simulation control of the parity runner (scripts/sofa-company/run.mjs --backend onto): same answers as the mock's
  // /kpi, /log, /notices, /state, /reset, /scenario/:id/start. Reset and scenarios are written as events and audited.
  for (const p of ['kpi', 'log', 'notices', 'state']) r.get(`/liquid/sim/${p}`, pass('GET', () => `/internal/sim/${p}`));
  r.post('/liquid/sim/reset', pass('POST', () => '/internal/sim/reset', 'liquid.sim.reset'));
  r.post('/liquid/sim/scenario/:id/start', pass('POST', (req) => `/internal/sim/scenario/${encodeURIComponent(String(req.params.id))}/start`, 'liquid.sim.scenario'));

  // Projection maintenance
  r.post('/liquid/projection/rebuild', pass('POST', (req) => `/internal/projection/rebuild${req.query.dryRun === 'true' ? '?dryRun=true' : ''}`, 'liquid.projection.rebuild'));
  r.get('/liquid/projection/dq', pass('GET', () => '/internal/projection/dq'));

  // Business workflows (ADR-0045): list, hold/release by ontology object, decide approvals (four eyes)
  if (processes) {
    const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    r.get('/liquid/processes', async (_req, res, next) => {
      try {
        res.json(await processes.list());
      } catch (err) {
        next(err);
      }
    });
    r.post('/liquid/processes/hold', async (req, res, next) => {
      try {
        const objects = Array.isArray(req.body?.objects) ? (req.body.objects as unknown[]).map(String) : [];
        const reason = str(req.body?.reason) ?? 'held from the admin console';
        const ref = `console-${Date.now().toString(36)}`;
        const out = await processes.hold(objects, `${reason} (${by(req)})`, ref);
        await audit?.write({ by: by(req), action: 'liquid.process.hold', target: objects.join(','), details: { ref, reason, workflows: out.workflows.length } });
        res.json(out);
      } catch (err) {
        next(err);
      }
    });
    r.post('/liquid/processes/release', async (req, res, next) => {
      try {
        const ref = str(req.body?.ref, 120);
        if (!ref) throw new HttpError(400, 'ref is required');
        const out = await processes.release(ref);
        await audit?.write({ by: by(req), action: 'liquid.process.release', target: ref, details: { workflows: out.workflows.length } });
        res.json(out);
      } catch (err) {
        next(err);
      }
    });
    r.get('/liquid/approvals/:workflowId', async (req, res, next) => {
      try {
        res.json(await processes.approval(String(req.params.workflowId)));
      } catch (err) {
        next(err);
      }
    });
    r.post('/liquid/approvals/:workflowId/decide', async (req, res, next) => {
      try {
        const decision = req.body?.decision;
        if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'decision must be approve or reject');
        const workflowId = String(req.params.workflowId);
        const out = await processes.decide(workflowId, decision, by(req), str(req.body?.comment));
        await audit?.write({ by: by(req), action: `liquid.approval.${decision}`, target: workflowId, details: { comment: str(req.body?.comment) } });
        res.json(out);
      } catch (err) {
        next(err);
      }
    });
  }

  // Policy as code (ADR-0044): bundle state, overlays, OPA's recent decisions
  if (policy) {
    r.get('/liquid/policy', async (_req, res, next) => policy.status().then((x) => res.json(x), next));
    r.post('/liquid/policy/overlays', async (req, res, next) => {
      try {
        const o = await policy.addOverlay(req.body ?? {}, by(req));
        await audit?.write({ by: by(req), action: 'liquid.policy.overlay.add', target: o.id, details: { effect: o.effect, match: o.match, reason: o.reason } });
        res.status(201).json(o);
      } catch (err) {
        next(err instanceof Error && err.name === 'ZodError' ? new HttpError(400, err.message) : err);
      }
    });
    // removing an overlay loosens the policy: a person (Platform.Admin session) only, audited
    r.delete('/liquid/policy/overlays/:id', async (req, res, next) => {
      try {
        const o = await policy.removeOverlay(String(req.params.id));
        if (!o) throw new HttpError(404, 'overlay not found');
        await audit?.write({ by: by(req), action: 'liquid.policy.overlay.remove', target: o.id, details: { effect: o.effect, match: o.match } });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    });
  }
  return r;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The policy package (ADR-0049) for the MCP gateway (bearer = gateway token) and the enterprise core (bearer = the
 * extension's policy_token). ETag = revision.
 */
export function liquidInternalRouter(ext: ExtensionService, policy: LiquidPolicyService, gatewayToken: string): Router {
  const r = Router();
  r.get('/liquid/policy', async (req, res, next) => {
    try {
      const got = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const core = ext.secret(LIQUID_ID, 'policy_token');
      const consumer = gatewayToken && safeEqual(got, gatewayToken) ? 'gateway' : core && safeEqual(got, core) ? 'core' : undefined;
      if (!consumer) return void res.status(401).json({ error: 'unauthorized' });
      if (!ext.isInstalled(LIQUID_ID)) return void res.status(404).json({ error: 'Liquid Enterprise is not installed' });
      const pkg = await policy.package();
      const etag = `"${pkg.revision}"`;
      const notModified = req.header('if-none-match') === etag;
      policy.recordFetch(consumer, pkg.revision, notModified);
      res.setHeader('ETag', etag);
      if (notModified) return void res.status(304).end();
      res.json(pkg);
    } catch (err) {
      next(err);
    }
  });
  return r;
}
