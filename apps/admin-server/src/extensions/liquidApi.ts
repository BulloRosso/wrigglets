import { Router } from 'express';
import { HttpError } from '../agents.js';
import { requireExtension } from './api.js';
import { LIQUID_ID, ontologyCall } from './liquid.js';
import type { ExtensionService } from './service.js';

/* Admin console routes of Liquid Enterprise (Platform.Admin); 404 while the extension is not available. */
export function liquidAdminRouter(ext: ExtensionService): Router {
  const r = Router();
  const ctx = {
    url: (service: string) => ext.url(LIQUID_ID, service),
    secret: (name: string) => {
      const v = ext.secret(LIQUID_ID, name);
      if (!v) throw new HttpError(503, `liquid secret ${name} is missing`);
      return v;
    },
  };
  r.use('/liquid', requireExtension(ext, LIQUID_ID));
  /** Event log and lake: high-water mark, snapshots, extracts, last flush, row counts. */
  r.get('/liquid/lake', async (_req, res) => {
    try {
      const [status, counts] = await Promise.all([ontologyCall<Record<string, unknown>>(ctx, 'GET', '/internal/lake/status'), ontologyCall<Record<string, number>>(ctx, 'GET', '/internal/lake/counts')]);
      res.json({ ...status, counts });
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(502, (err as Error).message);
    }
  });
  /** The compiled ontology (IR) the ontology server runs on; the editor's graph is built from it. */
  r.get('/liquid/ontology', async (_req, res) => {
    try {
      res.json(await ontologyCall<Record<string, unknown>>(ctx, 'GET', '/internal/ontology'));
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(502, (err as Error).message);
    }
  });
  return r;
}
