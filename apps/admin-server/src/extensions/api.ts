import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { installBody, uninstallBody } from '@cw/extensions';
import { HttpError } from '../agents.js';
import { ExtensionError, type ExtensionService } from './service.js';

/* Admin console routes of the extension manager (ADR-0039). Mounted in the Platform.Admin extension router. */

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((err) => next(err instanceof ExtensionError ? new HttpError(err.status, err.message) : err));
};

/** 404 unless the extension's features are on (installed and healthy, or overlay). Use on every route of an extension. */
export const requireExtension =
  (svc: ExtensionService, id: string): RequestHandler =>
  (_req, _res, next) => {
    svc
      .isAvailable(id)
      .then((ok) => (ok ? next() : next(new HttpError(404, `The extension "${id}" is not installed (admin console → Extensions)`))))
      .catch(next);
  };

export function extensionsAdminRouter(svc: ExtensionService, by: (req: Request) => string): Router {
  const r = Router();
  const p = (req: Request) => String(req.params.id);
  r.get('/extensions', wrap(async (_req, res) => res.json(await svc.list())));
  r.get('/extensions/:id', wrap(async (req, res) => res.json(await svc.status(p(req)))));
  r.post('/extensions/:id/install', wrap(async (req, res) => res.status(202).json(await svc.install(p(req), installBody.parse(req.body ?? {}), by(req)))));
  r.post('/extensions/:id/repair', wrap(async (req, res) => res.status(202).json(await svc.repair(p(req), by(req)))));
  r.post('/extensions/:id/uninstall', wrap(async (req, res) => res.status(202).json(await svc.uninstall(p(req), uninstallBody.parse(req.body ?? {}), by(req)))));
  r.get(
    '/extensions/:id/services/:service/logs',
    wrap(async (req, res) => {
      const tail = Number(req.query.tail ?? 200);
      res.type('text/plain').send(await svc.logs(p(req), String(req.params.service), Number.isFinite(tail) ? tail : 200));
    }),
  );
  return r;
}
