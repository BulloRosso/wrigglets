import { Router } from 'express';
import express from 'express';
import { AVATAR_MOODS, agentWorkflowId, stepFileName, type AgentStatusResponse, type AuditSearchResult, type CommitInfo } from '@cw/shared';
import { SA, q } from '@cw/shared/search-attributes';
import { agentStatusQuery } from '@cw/workflows/messages';
import { handleCodecRequest } from '@cw/codec';
import { requireRole } from '../auth.js';
import { HttpError, type ApiDeps } from '../context.js';
import { listExecutions, toListItem } from './tasks.js';

export function miscRouter(deps: ApiDeps): Router {
  const r = Router();
  const { config, temporal } = deps;

  r.get('/me', (req, res) => {
    res.json({
      user: req.user,
      agent: { agentId: config.AGENT_ID, displayName: config.AGENT_DISPLAY_NAME },
      roles: config.roles,
      authMode: config.AUTH_MODE,
      temporalUiUrl: process.env.TEMPORAL_UI_URL,
      temporalNamespace: config.TEMPORAL_NAMESPACE,
    });
  });

  r.get('/agent/status', async (_req, res) => {
    const [status, health] = await Promise.all([
      temporal.workflow.getHandle(agentWorkflowId(config.AGENT_ID)).query(agentStatusQuery),
      deps.health(),
    ]);
    const ids = [status.holder?.taskId, ...status.waiting.map((w) => w.taskId)].filter((x): x is string => !!x);
    const titles = new Map<string, string>();
    if (ids.length) {
      const list = await listExecutions(deps, `WorkflowId IN (${ids.map(q).join(',')})`, ids.length * 2);
      for (const w of list) titles.set(w.workflowId, w.typedSearchAttributes.get(SA.TaskTitle) ?? w.workflowId);
    }
    const body: AgentStatusResponse = {
      agentId: config.AGENT_ID,
      displayName: config.AGENT_DISPLAY_NAME,
      holder: status.holder ? { ...status.holder, title: titles.get(status.holder.taskId) } : undefined,
      waiting: status.waiting.map((w) => ({ ...w, title: titles.get(w.taskId) })),
      stats: { grantsTotal: status.stats.grantsTotal },
      health,
      killSwitch: status.killSwitch,
    };
    res.json(body);
  });

  /** Portrait of this agent (generated in the admin console), proxied from the control plane. */
  const avatarCache = new Map<string, { at: number; etag?: string; body?: Buffer }>();
  r.get('/avatar/:mood', async (req, res) => {
    const mood = String(req.params.mood);
    if (!(AVATAR_MOODS as readonly string[]).includes(mood)) throw new HttpError(404, 'unknown mood');
    if (!config.CONTROL_PLANE_URL || !config.CONTROL_PLANE_TOKEN) throw new HttpError(404, 'no portrait');
    let entry = avatarCache.get(mood);
    if (!entry || Date.now() - entry.at > 60_000) {
      const up = await fetch(`${config.CONTROL_PLANE_URL}/internal/avatars/${encodeURIComponent(config.AGENT_ID)}/${mood}`, {
        headers: { authorization: `Bearer ${config.CONTROL_PLANE_TOKEN}`, ...(entry?.etag ? { 'if-none-match': entry.etag } : {}) },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      if (up?.status === 304 && entry) entry = { ...entry, at: Date.now() };
      else if (up?.ok) entry = { at: Date.now(), etag: up.headers.get('etag') ?? undefined, body: Buffer.from(await up.arrayBuffer()) };
      else if (up) entry = { at: Date.now() };
      if (entry) avatarCache.set(mood, entry);
    }
    if (!entry?.body) throw new HttpError(404, 'no portrait');
    if (entry.etag) res.setHeader('ETag', entry.etag);
    if (entry.etag && req.header('if-none-match') === entry.etag) return void res.status(304).end();
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.type('png').send(entry.body);
  });

  r.get('/notifications', async (req, res) => {
    res.json(await deps.notifications.forUser(req.user!.upn, 50));
  });

  /** Audit search: tasks (visibility + audit exports) and commits (messages + content changes). */
  r.get('/audit/search', async (req, res) => {
    const text = String(req.query.q ?? '').trim();
    const person = String(req.query.person ?? '').trim().toLowerCase();
    const pathFilter = String(req.query.path ?? '').trim();
    if (text.length > 200) throw new HttpError(400, 'query too long');
    const clauses = [`AgentId = ${q(config.AGENT_ID)}`, `WorkflowType = 'taskWorkflow'`];
    if (person) clauses.push(`(RequestedBy = ${q(person)} OR ApprovedBy = ${q(person)})`);
    if (req.query.from) clauses.push(`StartTime >= ${q(new Date(String(req.query.from)).toISOString())}`);
    if (req.query.to) clauses.push(`StartTime <= ${q(new Date(String(req.query.to)).toISOString())}`);
    const executions = (await listExecutions(deps, clauses.join(' AND '), 300)).map(toListItem);
    const needle = text.toLowerCase();
    const tasks: AuditSearchResult['tasks'] = executions
      .filter((t) => !needle || t.title.toLowerCase().includes(needle) || t.taskId.toLowerCase().includes(needle))
      .map((t) => ({ taskId: t.taskId, title: t.title, status: String(t.status), requestedBy: t.requestedBy, approvedBy: t.approvedBy, startTime: t.startTime, source: 'visibility' as const, match: needle ? 'title' : undefined }));

    // Audit exports contain instructions, comments and approval notes (also beyond retention).
    if (text) {
      const grep = await deps.git.run(['grep', '-l', '-i', '-F', text, '--', '.agent/audit'], { allowFail: true });
      for (const file of grep.stdout.split('\n').filter(Boolean)) {
        const base = file.split('/').pop()!.replace(/\.json$/, '');
        if (tasks.some((t) => stepFileName(t.taskId) === base)) continue;
        const known = executions.find((e) => stepFileName(e.taskId) === base);
        tasks.push({ taskId: known?.taskId ?? base, title: known?.title ?? base, status: known ? String(known.status) : 'archived', requestedBy: known?.requestedBy ?? '', approvedBy: known?.approvedBy ?? [], startTime: known?.startTime, source: 'audit-export', match: 'audit export' });
      }
    }

    const commits = new Map<string, CommitInfo>();
    if (text || pathFilter || person) {
      const searches = [
        text ? deps.git.log({ grep: text, ignoreCase: true, files: true, limit: 50, path: pathFilter || undefined }) : Promise.resolve([]),
        text ? deps.git.log({ pickaxe: text, files: true, limit: 50, path: pathFilter || undefined }) : Promise.resolve([]),
        !text ? deps.git.log({ files: true, limit: 100, path: pathFilter || undefined }) : Promise.resolve([]),
      ];
      for (const list of await Promise.all(searches)) for (const c of list) commits.set(c.hash, c);
    }
    let commitList = [...commits.values()];
    if (person) {
      commitList = commitList.filter(
        (c) =>
          c.author.email.toLowerCase() === person ||
          c.trailers['Requested-By']?.some((v) => v.toLowerCase() === person) ||
          c.trailers['Approved-By']?.some((v) => v.toLowerCase() === person),
      );
    }
    commitList.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ tasks: tasks.slice(0, 100), commits: commitList.slice(0, 100) } satisfies AuditSearchResult);
  });

  r.post('/admin/agent/force-release', requireRole(config.roles.admin), express.json(), async (req, res) => {
    const taskId = String(req.body?.taskId ?? '');
    if (!taskId) throw new HttpError(400, 'taskId required');
    await temporal.workflow.getHandle(agentWorkflowId(config.AGENT_ID)).signal('forceRelease', { taskId, by: { upn: req.user!.upn, name: req.user!.name, oid: req.user!.oid } });
    await deps.audit.write({ by: req.user!.upn, action: 'force-release', target: taskId });
    res.status(204).end();
  });

  r.get('/admin/audit-log', requireRole(config.roles.admin), async (_req, res) => {
    res.json(await deps.audit.find(() => true, 200));
  });

  return r;
}

/** Codec server for the Temporal Web UI (spec §7.10). Admin role required. */
export function codecRouter(deps: ApiDeps): Router {
  const r = Router();
  const origins = new Set(deps.config.codecCorsOrigins);
  r.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,x-namespace,authorization');
      res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  return r;
}

export function codecHandlers(deps: ApiDeps): Router {
  const r = Router();
  r.post('/encode', requireRole(deps.config.roles.admin), async (req, res) => res.json(await handleCodecRequest(deps.codec, 'encode', req.body)));
  r.post('/decode', requireRole(deps.config.roles.admin), async (req, res) => res.json(await handleCodecRequest(deps.codec, 'decode', req.body)));
  return r;
}
