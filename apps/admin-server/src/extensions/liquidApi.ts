import { timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type RequestHandler } from 'express';
import { HttpError } from '../agents.js';
import { requireExtension } from './api.js';
import { LIQUID_ID, ontologyCall } from './liquid.js';
import type { ExtensionService } from './service.js';
import type { LiquidPolicyService } from './liquidPolicy.js';

/* Admin console routes of Liquid Enterprise (Platform.Admin); 404 while the extension is not available. */

interface Audit {
  write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void>;
}

export function liquidAdminRouter(ext: ExtensionService, audit?: Audit, by: (req: Request) => string = () => 'admin', policy?: LiquidPolicyService): Router {
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

  // Simulation control of the parity runner (scripts/sofa-company/run.mjs --backend onto): same answers as the mock's
  // /kpi, /log, /notices, /state, /reset, /scenario/:id/start. Reset and scenarios are written as events and audited.
  for (const p of ['kpi', 'log', 'notices', 'state']) r.get(`/liquid/sim/${p}`, pass('GET', () => `/internal/sim/${p}`));
  r.post('/liquid/sim/reset', pass('POST', () => '/internal/sim/reset', 'liquid.sim.reset'));
  r.post('/liquid/sim/scenario/:id/start', pass('POST', (req) => `/internal/sim/scenario/${encodeURIComponent(String(req.params.id))}/start`, 'liquid.sim.scenario'));

  // Projection maintenance
  r.post('/liquid/projection/rebuild', pass('POST', (req) => `/internal/projection/rebuild${req.query.dryRun === 'true' ? '?dryRun=true' : ''}`, 'liquid.projection.rebuild'));
  r.get('/liquid/projection/dq', pass('GET', () => '/internal/projection/dq'));

  // Policy as code (ADR-0044): bundle state, overlays, OPA's recent decisions
  if (policy) {
    r.get('/liquid/policy', (_req, res) => res.json(policy.status()));
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

/** Machine-to-machine routes for OPA (bearer = the extension's opa_bundle_token): bundle and decision logs. */
export function liquidInternalRouter(ext: ExtensionService, policy: LiquidPolicyService): Router {
  const r = Router();
  const auth: RequestHandler = (req, res, next) => {
    const token = ext.secret(LIQUID_ID, 'opa_bundle_token');
    const got = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !ext.isInstalled(LIQUID_ID) || !safeEqual(got, token)) return void res.status(401).json({ error: 'unauthorized' });
    next();
  };
  r.get('/liquid/opa/bundle.tar.gz', auth, async (req, res, next) => {
    try {
      const { revision, body } = await policy.bundle();
      const etag = '"' + revision + '"';
      const notModified = req.header('if-none-match') === etag;
      policy.recordFetch(revision, notModified);
      res.setHeader('ETag', etag);
      if (notModified) return void res.status(304).end();
      res.type('application/gzip').send(body);
    } catch (err) {
      next(err);
    }
  });
  r.post('/liquid/opa/logs', auth, express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
    try {
      // body-parser already inflates Content-Encoding: gzip; detect a still-compressed body by its magic bytes
      const body = req.body as Buffer;
      policy.recordDecisions(body, body.length > 2 && body[0] === 0x1f && body[1] === 0x8b);
    } catch {
      /* malformed log batch: ignore, OPA retries */
    }
    res.status(204).end();
  });
  return r;
}
