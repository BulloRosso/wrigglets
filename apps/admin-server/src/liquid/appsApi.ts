import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { HttpError } from '../agents.js';
import { requireExtension } from '../extensions/api.js';
import { LIQUID_ID } from '../extensions/liquid.js';
import type { ExtensionService } from '../extensions/service.js';
import { AppError, registerBody, type AppRegistry } from './apps.js';

/* App registry routes (ADR-0050), Platform.Admin: register, check, activate, extend, disable. */

const h =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) =>
    fn(req, res).catch((err: unknown) => next(err instanceof AppError ? new HttpError(err.status, err.message) : err));

interface AccessAdmin {
  users(): Promise<Array<{ id: string; email: string; name: string; disabled?: boolean; platformRoles: string[]; agentRoles: Record<string, string[]> }>>;
  setAgentRoles(userId: string, agentId: string, roles: string[]): Promise<unknown>;
}

export function appsRouter(ext: ExtensionService, apps: AppRegistry, by: (req: Request) => string, access?: AccessAdmin, audit?: { write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void> }): Router {
  const r = Router();
  r.use('/liquid/apps', requireExtension(ext, LIQUID_ID));
  const view = (id: string) => {
    const a = apps.get(id);
    if (!a) throw new HttpError(404, `no app ${id}`);
    return { ...a, url: apps.url(id) };
  };
  r.get('/liquid/apps', h(async (_req, res) => res.json(apps.list().map((a) => ({ ...a, url: apps.url(a.id) })))));
  r.get('/liquid/apps/:id', h(async (req, res) => res.json({ ...view(String(req.params.id)), fileList: await apps.files(String(req.params.id)) })));
  r.post(
    '/liquid/apps',
    h(async (req, res) => {
      const parsed = registerBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const a = await apps.register(parsed.data, by(req));
      res.status(201).json({ ...a, url: apps.url(a.id) });
    }),
  );
  r.post('/liquid/apps/:id/activate', h(async (req, res) => res.json({ ...(await apps.activate(String(req.params.id), by(req))), url: apps.url(String(req.params.id)) })));
  r.post('/liquid/apps/:id/disable', h(async (req, res) => res.json(await apps.disable(String(req.params.id), by(req), typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : undefined))));
  r.post('/liquid/apps/:id/extend', h(async (req, res) => res.json(await apps.extend(String(req.params.id), Number(req.body?.days ?? 180), by(req)))));
  r.post('/liquid/apps/:id/recheck', h(async (req, res) => res.json(await apps.recheck(String(req.params.id), by(req)))));
  /** Who may use an app: the role Agent.User on its OIDC client (app-<id>); administrators always may. */
  if (access) {
    r.get(
      '/liquid/apps/:id/access',
      h(async (req, res) => {
        const id = `app-${String(view(String(req.params.id)).id)}`;
        res.json(
          (await access.users())
            .filter((u) => !u.disabled)
            .map((u) => {
              // inherited access (administrators, users with Agent.User on all agents) cannot be revoked per app
              const via = u.platformRoles.includes('Platform.Admin') ? 'admin' : (u.agentRoles['*'] ?? []).includes('Agent.User') ? 'all agents' : (u.agentRoles[id] ?? []).includes('Agent.User') ? 'app' : null;
              return { id: u.id, email: u.email, name: u.name, admin: via === 'admin', allowed: via !== null, via };
            }),
        );
      }),
    );
    r.put(
      '/liquid/apps/:id/access/:userId',
      h(async (req, res) => {
        const a = view(String(req.params.id));
        const allowed = req.body?.allowed === true;
        await access.setAgentRoles(String(req.params.userId), `app-${a.id}`, allowed ? ['Agent.User'] : []);
        await audit?.write({ by: by(req), action: 'liquid.app.access', target: `${a.id}/${String(req.params.userId)}`, details: { allowed } });
        res.json({ ok: true });
      }),
    );
  }
  return r;
}
