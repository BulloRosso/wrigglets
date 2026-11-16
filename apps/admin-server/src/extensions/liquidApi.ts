import { Router, type Request, type RequestHandler } from 'express';
import { HttpError } from '../agents.js';
import { requireExtension } from './api.js';
import { LIQUID_ID, ontologyCall } from './liquid.js';
import type { ExtensionService } from './service.js';

/* Admin console routes of Liquid Enterprise (Platform.Admin); 404 while the extension is not available. */

interface Audit {
  write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void>;
}

export function liquidAdminRouter(ext: ExtensionService, audit?: Audit, by: (req: Request) => string = () => 'admin'): Router {
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
  return r;
}
