import { timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { observationBody, type SignalsHubStatus } from '@cw/shared';
import { HttpError } from './agents.js';
import type { Config } from './config.js';
import type { AgentRegistry } from './registry.js';
import { SignalsError, type SignalsControlService } from './signals.js';

/*
 * HTTP surface of Signals on the control plane (ADR-0037). Everything answers 404 "not configured" unless the signals
 * hub is configured (SIGNALS_HUB_URL + SIGNALS_HUB_TOKEN), which keeps the module optional.
 */

export interface SignalsApiDeps {
  config: Pick<Config, 'SIGNALS_HUB_URL' | 'SIGNALS_HUB_TOKEN'>;
  signals: SignalsControlService;
  registry: Pick<AgentRegistry, 'get'>;
}

const bearer = (req: Request) => req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const signalsAvailable = (c: SignalsApiDeps['config']) => !!c.SIGNALS_HUB_URL && !!c.SIGNALS_HUB_TOKEN;

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((err) => next(err instanceof SignalsError ? new HttpError(err.status, err.message) : err));
};

const connectorId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);

/** Admin console routes (Platform.Admin, mounted in the extension router). */
export function signalsAdminRouter(d: SignalsApiDeps, by: (req: Request) => string): Router {
  const r = Router();
  const available = () => signalsAvailable(d.config);
  const requireAvailable: RequestHandler = (_req, _res, next) => (available() ? next() : next(new HttpError(404, 'Signals is not configured (SIGNALS_HUB_URL, SIGNALS_HUB_TOKEN)')));

  const hub = async (path: string) => {
    let res: globalThis.Response;
    try {
      res = await fetch(`${d.config.SIGNALS_HUB_URL!.replace(/\/$/, '')}/admin${path}`, { headers: { authorization: `Bearer ${d.config.SIGNALS_HUB_TOKEN}` }, signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new HttpError(502, 'The signals hub is not reachable');
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new HttpError(502, json.error ?? `signals hub returned ${res.status}`);
    return json;
  };

  r.get('/signals', (_req, res) => res.json({ available: available() }));
  r.get(
    '/signals/overview',
    requireAvailable,
    wrap(async (_req, res) => {
      const connectors = d.signals.connectors();
      const status = (await hub('/status').catch((err: Error) => ({ error: err.message }))) as SignalsHubStatus | { error: string };
      res.json({
        agents: d.signals.enabledAgents(),
        connectors: { ...connectors, http: connectors.http.map(({ tokenSha256: _t, ...s }) => s) },
        status,
      });
    }),
  );
  r.put(
    '/signals/connectors',
    requireAvailable,
    wrap(async (req, res) => {
      const out = await d.signals.setConnectors(req.body, by(req));
      res.json({ ...out, http: out.http.map(({ tokenSha256: _t, ...s }) => s) });
    }),
  );
  r.post(
    '/signals/http-sources',
    requireAvailable,
    wrap(async (req, res) => {
      const body = z.object({ id: connectorId, agentId: z.string().min(1).max(40) }).parse(req.body);
      res.status(201).json(await d.signals.createHttpSource(body.id, body.agentId, by(req)));
    }),
  );
  r.delete(
    '/signals/http-sources/:id',
    requireAvailable,
    wrap(async (req, res) => {
      await d.signals.deleteHttpSource(String(req.params.id), by(req));
      res.status(204).end();
    }),
  );
  r.get(
    '/agents/:id/signals',
    wrap((req, res) => {
      if (!d.registry.get(String(req.params.id))) throw new HttpError(404, 'agent not found');
      res.json({ available: available(), config: d.signals.agentConfig(String(req.params.id)) });
    }),
  );
  r.put(
    '/agents/:id/signals',
    requireAvailable,
    wrap(async (req, res) => {
      res.json(await d.signals.setAgentConfig(String(req.params.id), req.body, by(req)));
    }),
  );
  /** Hand in an observation by hand (admin console "test observation"). */
  r.post(
    '/agents/:id/signals/observations',
    requireAvailable,
    express.json({ limit: '128kb' }),
    wrap(async (req, res) => {
      const o = observationBody.parse(req.body);
      const out = await d.signals.forwardObservation({ ...o, agentId: String(req.params.id), by: by(req) });
      res.status(out.status).json(out.json);
    }),
  );
  return r;
}

/** Machine-to-machine routes, mounted under /internal. */
export function signalsInternalRouter(d: SignalsApiDeps): Router {
  const r = Router();
  const hubOnly: RequestHandler = (req, res, next) => {
    if (!signalsAvailable(d.config)) return void res.status(404).json({ error: 'signals not configured' });
    if (!safeEqual(bearer(req), d.config.SIGNALS_HUB_TOKEN!)) return void res.status(401).json({ error: 'unauthorized' });
    next();
  };

  /** Per-agent settings, fetched (and cached) by the agent. 404 = the module is not configured = off. */
  r.get('/agents/:agentId/signals-config', (req, res) => {
    const entry = d.registry.get(req.params.agentId);
    if (!entry || !safeEqual(bearer(req), entry.secrets.internalToken)) return void res.status(401).json({ error: 'unauthorized' });
    if (!signalsAvailable(d.config)) return void res.status(404).json({ error: 'signals not configured' });
    res.json(d.signals.agentConfig(req.params.agentId));
  });

  r.get('/signals-config', hubOnly, (_req, res) => res.json(d.signals.hubConfig()));
  r.post(
    '/signals/observations',
    hubOnly,
    express.json({ limit: '128kb' }),
    wrap(async (req, res) => {
      const out = await d.signals.forwardObservation(req.body);
      res.status(out.status).json(out.json);
    }),
  );
  // MCP tools of the hub (list / resolve the calling agent's expectations); the hub passes the agent the gateway verified
  r.get(
    '/signals/agents/:agentId/expectations',
    hubOnly,
    wrap(async (req, res) => {
      const out = await d.signals.callAgent(String(req.params.agentId), 'GET', '/expectations');
      res.status(out.status).json(out.json);
    }),
  );
  r.post(
    '/signals/agents/:agentId/expectations/:id/fulfill',
    hubOnly,
    express.json({ limit: '16kb' }),
    wrap(async (req, res) => {
      const body = z.object({ reason: z.string().trim().min(1).max(1000), by: z.string().trim().min(1).max(200) }).parse(req.body);
      const out = await d.signals.callAgent(String(req.params.agentId), 'POST', `/expectations/${encodeURIComponent(String(req.params.id))}/fulfill`, body);
      res.status(out.status).json(out.json);
    }),
  );
  return r;
}
