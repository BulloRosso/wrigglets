import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { mountA2a } from '../a2a/server.js';
import { mountGuard } from '../guard/route.js';
import { mountObo } from '../obo/route.js';
import { safetyStats } from '../safetyStats.js';
import type { Auth } from './auth.js';
import { errorHandler, type ApiDeps } from './context.js';
import { codecHandlers, codecRouter, miscRouter } from './routes/misc.js';
import { scheduleRouter } from './routes/schedules.js';
import { taskRouter } from './routes/tasks.js';
import { workspaceRouter } from './routes/workspace.js';

export function createApp(deps: ApiDeps, auth: Auth): Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.config.TRUST_PROXY) app.set('trust proxy', true);
  app.use(cookieParser());

  // Unauthenticated
  app.get('/health', async (_req, res) => {
    const h = await deps.health();
    res.status(h.status === 'down' ? 503 : 200).json(h);
  });
  auth.routes(app);

  // Machine-to-machine: safety counters for the control plane, A2A for the MCP gateway (own bearer tokens)
  app.get('/internal/stats', (req, res) => {
    const token = deps.config.CONTROL_PLANE_TOKEN;
    if (!token || req.header('authorization') !== `Bearer ${token}`) return void res.status(401).json({ error: 'unauthorized' });
    res.json(safetyStats.snapshot());
  });
  mountA2a(app, deps);
  mountGuard(app, deps.guard);
  mountObo(app, deps.obo, deps.config.A2A_GATEWAY_TOKEN);

  // Codec server (CORS for the Temporal Web UI, then auth)
  app.use('/codec', codecRouter(deps), auth.middleware, express.json({ limit: '4mb' }), codecHandlers(deps));

  // API (identity from server-side session / EasyAuth headers only)
  const api = express.Router();
  api.use(auth.middleware);
  api.use((req, res, next) => {
    if (!req.user!.roles.includes(deps.config.roles.user)) return res.status(403).json({ error: `requires role ${deps.config.roles.user}` });
    next();
  });
  api.use(express.json({ limit: '256kb' }));
  api.use(taskRouter(deps));
  api.use(scheduleRouter(deps));
  api.use(workspaceRouter(deps));
  api.use(miscRouter(deps));
  api.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use('/api', api);

  // Web UI (SPA). Requires a session; unauthenticated browser requests are redirected to sign-in.
  const webDir = deps.config.WEB_DIST_DIR ?? path.resolve(process.cwd(), '../agent-web/dist');
  if (existsSync(webDir)) {
    app.use('/assets', express.static(path.join(webDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.get('/favicon.svg', (_req, res) => res.sendFile(path.join(webDir, 'favicon.svg')));
    app.use(auth.middleware, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
