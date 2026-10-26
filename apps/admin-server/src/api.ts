import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { Router, type ErrorRequestHandler, type Express } from 'express';
import cookieParser from 'cookie-parser';
import { ZodError, z } from 'zod';
import { createOidcRp, requireRole } from '@cw/auth-rp';
import { handleCodecRequest } from '@cw/codec';
import { ALL_AGENT_ROLES, PLATFORM_ROLES, createAgentBody, createUserBody, updateAgentBody, updateUserBody, type PlatformOverview } from '@cw/shared';
import { q } from '@cw/shared/search-attributes';
import { AgentService, HttpError } from './agents.js';
import { enrichAsync, extensionRouter, internalRouter, type ExtensionDeps } from './apiExtensions.js';
import type { Config } from './config.js';
import { logger } from './logger.js';
import { OAuthAdminError, type OAuthAdmin } from './oauthAdmin.js';
import type { AdminAudit, AgentRegistry } from './registry.js';
import type { AgentRuntime } from './runtime/types.js';
import type { TemporalDevServer } from './temporal/devServer.js';
import type { TemporalPlatform } from './temporal/platform.js';

export interface AdminDeps {
  config: Config;
  registry: AgentRegistry;
  runtime: AgentRuntime;
  oauth: OAuthAdmin;
  temporal: TemporalPlatform;
  devServer?: TemporalDevServer;
  agents: AgentService;
  audit: AdminAudit;
  ext: ExtensionDeps;
}

export function createAdminApp(deps: AdminDeps): Express {
  const { config, registry, runtime, oauth, temporal, agents, audit, ext } = deps;
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', true);
  app.use(cookieParser());

  const rp = createOidcRp({
    issuer: config.OAUTH_ISSUER,
    internalUrl: config.oauthInternal,
    clientId: config.ADMIN_CLIENT_ID,
    clientSecret: config.ADMIN_CLIENT_SECRET,
    sessionSecret: config.SESSION_SECRET,
    sessionTtlMs: config.sessionTtlMs,
    cookieName: 'cw_admin',
    publicBaseUrl: config.publicUrl,
    requiredRole: PLATFORM_ROLES.admin,
    onSignIn: (u) => logger.info({ upn: u.upn }, 'admin signed in'),
  });

  app.get('/health', async (_req, res) => {
    const t = await temporal.healthy().catch(() => false);
    res.status(t ? 200 : 503).json({ status: t ? 'ok' : 'degraded', temporal: t ? 'up' : 'down' });
  });
  rp.routes(app);
  app.use('/internal', internalRouter(ext));

  /* ------------------------------------------------- codec server for the Temporal Web UI (spec §7.10) */
  const codec = Router();
  codec.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin === config.TEMPORAL_UI_PUBLIC_URL) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,x-namespace,authorization');
      res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  // Locally the Temporal UI (dev server) cannot forward our session cookie reliably; the codec is
  // restricted by CORS origin and bound to localhost. On Azure it sits behind Entra auth (ADR-0008).
  codec.use(express.json({ limit: '4mb' }));
  codec.post('/encode', async (req, res) => res.json(await handleCodecRequest(temporal.codec, 'encode', req.body)));
  codec.post('/decode', async (req, res) => res.json(await handleCodecRequest(temporal.codec, 'decode', req.body)));
  app.use('/codec', codec);

  /* ------------------------------------------------- API (Platform.Admin only) */
  const api = Router();
  api.use(rp.apiMiddleware, requireRole(PLATFORM_ROLES.admin), express.json({ limit: '256kb' }));
  const by = (req: express.Request) => req.user!.upn;
  // Safety, gateway, secrets and portraits first: their paths (e.g. /agents/:id/avatar) would otherwise match /agents/:id/:action.
  api.use(extensionRouter(ext, by));

  api.get('/me', (req, res) => res.json({ user: req.user, temporalUiUrl: config.TEMPORAL_UI_PUBLIC_URL, temporalNamespace: config.TEMPORAL_NAMESPACE, runtime: runtime.kind, oauthIssuer: config.OAUTH_ISSUER }));

  api.get('/overview', async (_req, res) => {
    const [tUp, oUp, rt] = await Promise.all([temporal.healthy(), oauth.healthy(), runtime.ping()]);
    const specs = registry.list();
    const infos = await Promise.all(specs.map((s) => runtime.inspect(s.agentId)));
    const base = `WorkflowType = 'taskWorkflow'`;
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const [open, awaiting, failed, completed] = tUp
      ? await Promise.all([
          temporal.count(`${base} AND ExecutionStatus = 'Running'`),
          temporal.count(`${base} AND ExecutionStatus = 'Running' AND TaskStatus = 'awaiting_approval'`),
          temporal.count(`${base} AND CloseTime >= ${q(day)} AND TaskStatus IN ('failed','budget_exceeded','expired')`),
          temporal.count(`${base} AND CloseTime >= ${q(day)} AND TaskStatus = 'completed'`),
        ])
      : [0, 0, 0, 0];
    const body: PlatformOverview = {
      temporal: { state: tUp ? 'up' : 'down', address: config.AGENT_TEMPORAL_ADDRESS, namespace: config.TEMPORAL_NAMESPACE, webUiUrl: config.TEMPORAL_UI_PUBLIC_URL, version: temporal.version },
      oauth: { state: oUp ? 'up' : 'down', issuer: config.OAUTH_ISSUER },
      runtime: { kind: runtime.kind, state: rt.ok ? 'up' : 'down', detail: rt.detail },
      agents: { total: specs.length, running: infos.filter((i) => i.state === 'running' || i.state === 'starting').length },
      tasks: { open, awaitingApproval: awaiting, failed24h: failed, completed24h: completed },
    };
    res.json(body);
  });

  api.get('/tasks', async (req, res) => {
    const clauses = [`WorkflowType = 'taskWorkflow'`];
    if (req.query.agentId) clauses.push(`AgentId = ${q(String(req.query.agentId))}`);
    if (req.query.status) clauses.push(`TaskStatus = ${q(String(req.query.status))}`);
    res.json(await temporal.tasks(clauses.join(' AND '), Math.min(Number(req.query.limit ?? 25) || 25, 100)));
  });

  /* agents */
  api.get('/agents', async (req, res) => {
    const withHealth = req.query.health !== 'false';
    res.json(await Promise.all(registry.list().map(async (s) => enrichAsync(ext, await agents.summary(s, { withHealth })))));
  });
  api.post('/agents', async (req, res) => {
    const body = createAgentBody.parse(req.body);
    const result = await agents.create(body, by(req));
    await audit.write({ by: by(req), action: 'agent.create', target: body.agentId, details: { image: result.spec.image, port: result.spec.hostPort, model: result.spec.model } });
    void ext.gateway.push();
    res.status(201).json(await enrichAsync(ext, await agents.summary(result.spec, { withHealth: false })));
  });
  api.get('/agents/:id', async (req, res) => {
    const entry = registry.get(req.params.id);
    if (!entry) throw new HttpError(404, 'agent not found');
    res.json(await enrichAsync(ext, await agents.summary(entry.spec, { withHealth: true })));
  });
  api.patch('/agents/:id', async (req, res) => {
    const body = updateAgentBody.parse(req.body);
    const r = await agents.update(req.params.id, body);
    await audit.write({ by: by(req), action: body.peers ? 'agent.discovery' : 'agent.update', target: req.params.id, details: body });
    if (body.peers) void ext.gateway.push();
    res.json(await enrichAsync(ext, await agents.summary(r.spec, { withHealth: false })));
  });
  api.post('/agents/:id/:action', async (req, res) => {
    const id = req.params.id;
    if (!['start', 'stop', 'restart', 'redeploy'].includes(req.params.action)) throw new HttpError(404, 'unknown action');
    if (!registry.get(id)) throw new HttpError(404, 'agent not found');
    const action = req.params.action as 'start' | 'stop' | 'restart' | 'redeploy';
    if (action === 'redeploy') await agents.redeploy(id);
    else await runtime[action](id);
    await audit.write({ by: by(req), action: `agent.${action}`, target: id });
    res.json(await runtime.inspect(id));
  });
  api.delete('/agents/:id', async (req, res) => {
    const purgeData = req.query.purgeData === 'true';
    const removeAccess = req.query.removeAccess !== 'false';
    const result = await agents.remove(req.params.id, { purgeData, removeAccess });
    // remove the agent from every discovery set, its allow-list and kill-switch entry
    for (const other of registry.list()) {
      if (other.peers?.includes(req.params.id)) await agents.update(other.agentId, { peers: other.peers.filter((p) => p !== req.params.id) });
    }
    await ext.gateway.removeAgent(req.params.id);
    if (purgeData) await ext.avatars.remove(req.params.id);
    await audit.write({ by: by(req), action: 'agent.delete', target: req.params.id, details: { purgeData, removeAccess, ...result } });
    res.json(result);
  });
  api.get('/agents/:id/stats', async (req, res) => {
    res.json((await runtime.stats(req.params.id)) ?? null);
  });
  // AGENTS.md lives in the agent's workspace: proxied to the agent with its control-plane token; the agent commits as the admin.
  const agentsMd = async (agentId: string, init: { method: 'GET' } | { method: 'PUT'; body: unknown }) => {
    const entry = registry.get(agentId);
    if (!entry) throw new HttpError(404, 'agent not found');
    let res: Response;
    try {
      res = await fetch(`${runtime.internalUrl(agentId)}/internal/agents-md`, {
        method: init.method,
        headers: { authorization: `Bearer ${entry.secrets.internalToken}`, ...(init.method === 'PUT' ? { 'content-type': 'application/json' } : {}) },
        body: init.method === 'PUT' ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, 'agent not reachable (is it running?)');
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new HttpError(res.status === 401 ? 502 : res.status, json.error ?? 'agent request failed');
    return json;
  };
  api.get('/agents/:id/agents-md', async (req, res) => {
    res.json(await agentsMd(req.params.id, { method: 'GET' }));
  });
  api.put('/agents/:id/agents-md', async (req, res) => {
    const { content } = z.object({ content: z.string().max(256 * 1024) }).parse(req.body);
    const r = await agentsMd(req.params.id, { method: 'PUT', body: { content, by: { upn: req.user!.upn, name: req.user!.name } } });
    await audit.write({ by: by(req), action: 'agent.agents-md', target: req.params.id, details: r });
    res.json(r);
  });
  api.get('/agents/:id/logs', async (req, res) => {
    if (!registry.get(req.params.id)) throw new HttpError(404, 'agent not found');
    const follow = req.query.follow !== 'false';
    const tail = Math.min(Number(req.query.tail ?? 300) || 300, 5000);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    const stop = await runtime.logs(
      req.params.id,
      { tail, follow },
      (line, stream) => res.write(`data: ${JSON.stringify({ line, stream })}\n\n`),
      () => {
        clearInterval(keepalive);
        res.write('event: end\ndata: {}\n\n');
        res.end();
      },
    );
    req.on('close', () => {
      clearInterval(keepalive);
      stop();
    });
  });
  api.get('/agents/:id/access', async (req, res) => {
    const users = await oauth.users();
    const id = req.params.id;
    res.json(
      users.map((u) => ({
        userId: u.id,
        email: u.email,
        name: u.name,
        disabled: u.disabled,
        roles: [...new Set([...(u.agentRoles[id] ?? [])])],
        inheritedRoles: u.platformRoles.includes(PLATFORM_ROLES.admin) ? ALL_AGENT_ROLES : (u.agentRoles['*'] ?? []),
      })),
    );
  });
  api.put('/agents/:id/access/:userId', async (req, res) => {
    const { roles } = z.object({ roles: z.array(z.enum(ALL_AGENT_ROLES as [string, ...string[]])).max(3) }).parse(req.body);
    const u = await oauth.setAgentRoles(req.params.userId, req.params.id, roles);
    await audit.write({ by: by(req), action: 'access.set', target: `${req.params.id}/${u.email}`, details: { roles } });
    res.json(u);
  });

  api.get('/images', async (_req, res) => res.json(await runtime.images()));

  /* identity */
  api.get('/users', async (_req, res) => res.json(await oauth.users()));
  api.post('/users', async (req, res) => {
    const body = createUserBody.parse(req.body);
    const u = await oauth.createUser(body);
    await audit.write({ by: by(req), action: 'user.create', target: u.email, details: { platformRoles: u.platformRoles, agentRoles: u.agentRoles } });
    res.status(201).json(u);
  });
  api.patch('/users/:id', async (req, res) => {
    const body = updateUserBody.parse(req.body);
    if (body.disabled === true || body.platformRoles) {
      const me = (await oauth.users()).find((u) => u.email === req.user!.upn);
      if (me?.id === req.params.id && (body.disabled || !body.platformRoles?.includes(PLATFORM_ROLES.admin))) {
        throw new HttpError(400, 'You cannot disable yourself or remove your own admin role');
      }
    }
    const u = await oauth.updateUser(req.params.id, body);
    const { password: _pw, ...logged } = body;
    await audit.write({ by: by(req), action: 'user.update', target: u.email, details: { ...logged, passwordChanged: !!body.password } });
    res.json(u);
  });
  api.post('/users/:id/revoke-sessions', async (req, res) => {
    const r = await oauth.revokeSessions(req.params.id);
    await audit.write({ by: by(req), action: 'user.revoke-sessions', target: req.params.id, details: r });
    res.json(r);
  });
  api.delete('/users/:id', async (req, res) => {
    const me = (await oauth.users()).find((u) => u.email === req.user!.upn);
    if (me?.id === req.params.id) throw new HttpError(400, 'You cannot delete yourself');
    await oauth.deleteUser(req.params.id);
    await audit.write({ by: by(req), action: 'user.delete', target: req.params.id });
    res.status(204).end();
  });
  api.get('/clients', async (_req, res) => res.json(await oauth.clients()));
  api.get('/audit', async (req, res) => {
    const target = req.query.target ? String(req.query.target) : undefined;
    res.json(await audit.list(300, target ? (e) => e.target === target || e.target.startsWith(`${target}/`) : undefined));
  });

  api.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use('/api', api);

  /* ------------------------------------------------- admin UI */
  const webDir = config.WEB_DIST_DIR ?? path.resolve(process.cwd(), '../admin-web/dist');
  if (existsSync(webDir)) {
    app.use('/assets', express.static(path.join(webDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.get('/favicon.svg', (_req, res) => res.sendFile(path.join(webDir, 'favicon.svg')));
    app.use(rp.middleware, requireRole(PLATFORM_ROLES.admin), (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), issues: err.issues });
    if (err instanceof HttpError || err instanceof OAuthAdminError) return res.status(err.status).json({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return res.status(status).json({ error: (err as Error).message });
    logger.error({ err, path: req.path }, 'request failed');
    res.status(500).json({ error: (err as Error).message ?? 'internal error' });
  };
  app.use(onError);
  return app;
}
