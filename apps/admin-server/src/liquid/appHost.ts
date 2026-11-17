import { existsSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { createOidcRp, escapeHtml } from '@cw/auth-rp';
import type { AppRecord, AppRegistry } from './apps.js';

/*
 * App host of Liquid Enterprise (ADR-0050). Registered apps are served here, on an origin of their own (APPS_PORT),
 * never on the admin console's — app code must not be able to reach the console API with an admin's cookie.
 *
 *   /apps/<id>/                  the app's built files, with a strict CSP (connect-src 'self', no inline script)
 *   /apps/<id>/auth/*            sign-in with the app's own OIDC client (local OAuth server, role Agent.User)
 *   /apps/<id>/api/me            who is signed in
 *   /apps/<id>/api/objects/:c    read a class the app is registered for
 *   /apps/<id>/api/actions/:a    run an action the app is registered for, as the signed-in person
 *
 * The browser never holds a token of the enterprise core: the host forwards with its internal token and sets the
 * caller (_requestedBy = the person, _app = the app); caller fields from the browser are dropped. API calls must come
 * from the app's own pages (custom header + Referer below /apps/<id>/), so one app cannot use another app's session.
 * An app that is not active (registered, disabled, expired) answers 410.
 */

export interface AppHostDeps {
  registry: AppRegistry;
  appsPublicUrl: string;
  issuer: string;
  internalUrl?: string;
  sessionSecret: string;
  core: { url(): string; token(): string };
  enabled(): boolean;
  log?: { info(o: object, msg: string): void; warn(o: object, msg: string): void };
}

export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1d2733}a{color:#1f5fad}</style></head><body>${body}</body></html>`;

export function createAppHost(d: AppHostDeps): Express {
  const host = express();
  host.disable('x-powered-by');
  host.use(cookieParser());
  host.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', APP_CSP);
    next();
  });
  host.get('/health', (_req, res) => res.json({ status: 'ok' }));

  host.get('/', (_req, res) => {
    if (!d.enabled()) return void res.status(404).type('html').send(page('Apps', '<p>Liquid Enterprise is not installed.</p>'));
    const active = d.registry.list().filter((a) => a.status === 'active');
    res.type('html').send(page('Apps', `<h1>Apps</h1>${active.length ? `<ul>${active.map((a) => `<li><a href="/apps/${a.id}/">${escapeHtml(a.name)}</a> — ${escapeHtml(a.description)} <small>(owner ${escapeHtml(a.owner)}, until ${a.expiresAt.slice(0, 10)})</small></li>`).join('')}</ul>` : '<p>No active apps.</p>'}`));
  });

  const subs = new Map<string, { key: string; app: Express }>();
  const subFor = (a: AppRecord, client: { clientId: string; clientSecret: string }) => {
    const key = `${a.version}:${client.clientId}:${client.clientSecret}`;
    const cached = subs.get(a.id);
    if (cached?.key === key) return cached.app;
    const app = buildApp(d, a, client);
    subs.set(a.id, { key, app });
    return app;
  };

  host.use('/apps/:id', (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    if (!d.enabled()) return void res.status(404).type('html').send(page('Not found', '<p>Liquid Enterprise is not installed.</p>'));
    const a = d.registry.get(id);
    if (!a) return void res.status(404).type('html').send(page('Not found', `<p>There is no app <b>${escapeHtml(id)}</b>.</p>`));
    const client = d.registry.client(id);
    if (a.status !== 'active' || !client) {
      return void res.status(410).type('html').send(page(a.name, `<h1>${escapeHtml(a.name)}</h1><p>This app is not active (${escapeHtml(a.status)}${a.statusNote ? `: ${escapeHtml(a.statusNote)}` : ''}). Its owner is ${escapeHtml(a.owner)}.</p>`));
    }
    // relative URLs (./assets, api) need the trailing slash
    if (req.originalUrl.split('?')[0] === `/apps/${id}`) return void res.redirect(`/apps/${id}/`);
    subFor(a, client)(req, res, next);
  });
  return host;
}

function buildApp(d: AppHostDeps, a: AppRecord, client: { clientId: string; clientSecret: string }): Express {
  const app = express();
  app.disable('x-powered-by');
  const base = `${d.appsPublicUrl}/apps/${a.id}`;
  const rp = createOidcRp({
    issuer: d.issuer,
    internalUrl: d.internalUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    sessionSecret: `${d.sessionSecret}:app:${a.id}`,
    sessionTtlMs: 8 * 3_600_000,
    cookieName: `cw_app_${a.id.replace(/-/g, '_')}`,
    publicBaseUrl: base,
    requiredRole: 'Agent.User',
    accessDenied: (u) => page(a.name, `<p>${escapeHtml(u.name)}, you do not have access to the app <b>${escapeHtml(a.name)}</b>. Ask an administrator for the role Agent.User on it.</p><p><a href="/apps/${a.id}/auth/logout">Sign out</a></p>`),
    onSignIn: (u) => d.log?.info({ app: a.id, upn: u.upn }, 'app sign-in'),
  });
  rp.routes(app);

  // API calls only from this app's own pages
  const ownPage: RequestHandler = (req, res, next) => {
    const ref = req.header('referer') ?? '';
    if (req.header('x-liquid-app') !== '1' || !ref.startsWith(`${base}/`)) return void res.status(403).json({ error: 'API calls must come from the app itself' });
    next();
  };
  const core = async (method: string, p: string, body?: unknown, user?: string) => {
    const r = await fetch(`${d.core.url()}${p}`, {
      method,
      headers: { authorization: `Bearer ${d.core.token()}`, 'content-type': 'application/json', ...(user ? { 'x-requested-by': user } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: r.status, json: (await r.json().catch(() => ({ error: `enterprise core: HTTP ${r.status}` }))) as unknown };
  };

  const api = express.Router();
  api.use(rp.apiMiddleware, ownPage, express.json({ limit: '256kb' }));
  api.get('/me', (req, res) => res.json({ upn: req.user!.upn, name: req.user!.name, app: a.id }));
  api.get('/objects/:class', async (req, res, next) => {
    const cls = String(req.params.class);
    if (!a.reads.includes(cls)) return void res.status(403).json({ error: `the app ${a.id} is not registered to read ${cls}` });
    core('GET', `/objects/${encodeURIComponent(cls)}`).then((r) => res.status(r.status).json(r.json), next);
  });
  api.get('/objects/:class/:id', async (req, res, next) => {
    const cls = String(req.params.class);
    if (!a.reads.includes(cls)) return void res.status(403).json({ error: `the app ${a.id} is not registered to read ${cls}` });
    core('GET', `/objects/${encodeURIComponent(cls)}/${encodeURIComponent(String(req.params.id))}`).then((r) => res.status(r.status).json(r.json), next);
  });
  api.post('/actions/:name', async (req, res, next) => {
    const name = String(req.params.name);
    if (!a.actions.includes(name)) return void res.status(403).json({ error: `the app ${a.id} is not registered for the action ${name}` });
    const input = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).filter(([k]) => !k.startsWith('_')));
    core('POST', `/actions/${encodeURIComponent(name)}`, { ...input, _requestedBy: req.user!.upn, _app: a.id }, req.user!.upn).then((r) => res.status(r.status).json(r.json), next);
  });
  api.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use('/api', api);

  const dist = d.registry.distDir(a);
  app.use(rp.middleware);
  app.use(express.static(dist, { index: 'index.html', fallthrough: true, dotfiles: 'ignore' }));
  // single-page apps: unknown GET paths get index.html (hash routing recommended, relative URLs need the base)
  app.get(/.*/, (_req, res) => {
    const index = path.join(dist, 'index.html');
    if (!existsSync(index)) return void res.status(404).send('not found');
    res.sendFile(index);
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    d.log?.warn({ app: a.id, err: err.message }, 'app host error');
    if (!res.headersSent) res.status(502).json({ error: 'the app host could not complete the request' });
  });
  return app;
}
