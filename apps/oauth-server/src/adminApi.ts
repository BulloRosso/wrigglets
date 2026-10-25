import { timingSafeEqual } from 'node:crypto';
import express, { Router, type ErrorRequestHandler } from 'express';
import { ZodError, z } from 'zod';
import { createUserBody, updateUserBody, upsertClientBody } from '@cw/shared';
import { activeSessionCount, revokeSessionsOf } from './adapter.js';
import { toClientDto, toUserDto, type Store } from './store.js';

/**
 * Management API used by the admin plane (bearer token). Not reachable from browsers in
 * production deployments: the admin plane calls it server-to-server.
 */
export function adminApi(store: Store, token: string): Router {
  const r = Router();
  const expected = Buffer.from(`Bearer ${token}`);
  r.use((req, res, next) => {
    const got = Buffer.from(req.header('authorization') ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  r.use(express.json({ limit: '64kb' }));

  r.get('/stats', (_req, res) => {
    res.json({ users: store.listUsers().length, clients: store.listClients().length, activeSessions: activeSessionCount() });
  });

  r.get('/users', (_req, res) => res.json(store.listUsers().map(toUserDto)));
  r.get('/users/:id', (req, res) => {
    const u = store.findUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json(toUserDto(u));
  });
  r.post('/users', async (req, res) => {
    res.status(201).json(toUserDto(await store.createUser(createUserBody.parse(req.body))));
  });
  r.patch('/users/:id', async (req, res) => {
    const body = updateUserBody.parse(req.body);
    const user = await store.updateUser(req.params.id, body);
    if (body.disabled || body.password) revokeSessionsOf(user.id);
    res.json(toUserDto(user));
  });
  r.put('/users/:id/agent-roles/:agentId', async (req, res) => {
    const { roles } = z.object({ roles: z.array(z.string()).max(10) }).parse(req.body);
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'not found' });
    const agentRoles = { ...user.agentRoles, [req.params.agentId]: roles };
    res.json(toUserDto(await store.updateUser(user.id, { agentRoles })));
  });
  r.delete('/users/:id', async (req, res) => {
    revokeSessionsOf(req.params.id);
    await store.deleteUser(req.params.id);
    res.status(204).end();
  });
  r.post('/users/:id/revoke-sessions', (req, res) => {
    res.json({ revoked: revokeSessionsOf(req.params.id) });
  });

  r.get('/clients', (_req, res) => res.json(store.listClients().map(toClientDto)));
  r.put('/clients/:clientId', async (req, res) => {
    const body = upsertClientBody.parse({ ...req.body, clientId: req.params.clientId });
    res.json(toClientDto(await store.upsertClient(body)));
  });
  r.delete('/clients/:clientId', async (req, res) => {
    const c = store.findClient(req.params.clientId);
    await store.deleteClient(req.params.clientId);
    if (c?.kind === 'agent' && c.agentId && req.query.removeAssignments === 'true') await store.removeAgentAssignments(c.agentId);
    res.status(204).end();
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'validation failed', issues: err.issues });
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: status === 500 ? 'internal error' : (err as Error).message });
  };
  r.use(onError);
  return r;
}
