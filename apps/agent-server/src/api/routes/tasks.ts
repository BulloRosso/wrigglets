import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { LRUCache } from 'lru-cache';
import { ulid } from 'ulid';
import type { WorkflowExecutionInfo } from '@temporalio/client';
import {
  taskChatBody,
  UNLIMITED_TOKENS,
  TASK_ID_PATTERN,
  agentWorkflowId,
  stepFileName,
  cancelBody,
  commentBody,
  createTaskBody,
  decisionBody,
  listTasksQuery,
  toIdentity,
  type Principal,
  type TaskDetail,
  type TaskTrigger,
  type TaskInput,
  type TaskListItem,
  type TaskState,
  type Timeline,
} from '@cw/shared';
import { SA, q } from '@cw/shared/search-attributes';
import { cancelUpdate, commentUpdate, decideUpdate, taskStateQuery } from '@cw/workflows/messages';
import { metrics } from '../../telemetry.js';
import { decodeHistory } from '../../timeline/history.js';
import { mapHistory, mergeTimelines } from '../../timeline/mapHistory.js';
import { readAuditExport } from '../../activities/finalize.js';
import { TaskChat } from '../../chat/taskChat.js';
import { HttpError, type ApiDeps } from '../context.js';

export function taskSettings(deps: ApiDeps): TaskInput['settings'] {
  const c = deps.config;
  return {
    maxFixRounds: c.TASK_MAX_FIX_ROUNDS,
    approvalReminderAfter: c.APPROVAL_REMINDER_AFTER,
    approvalExpireAfter: c.APPROVAL_EXPIRE_AFTER,
    approverPolicy: c.APPROVER_POLICY,
    maxRevisions: c.TASK_MAX_REVISIONS,
  };
}

export function toListItem(w: WorkflowExecutionInfo): TaskListItem {
  const sa = w.typedSearchAttributes;
  return {
    taskId: w.workflowId,
    runId: w.runId,
    title: sa.get(SA.TaskTitle) ?? w.workflowId,
    type: (sa.get(SA.TaskType) ?? 'analysis') as TaskListItem['type'],
    status: sa.get(SA.TaskStatus) ?? w.status.name.toLowerCase(),
    requestedBy: sa.get(SA.RequestedBy) ?? '',
    trigger: sa.get(SA.Trigger) ?? 'user',
    scheduleId: sa.get(SA.ScheduleId),
    approvedBy: sa.get(SA.ApprovedBy) ?? [],
    startTime: w.startTime.toISOString(),
    closeTime: w.closeTime?.toISOString(),
    workflowStatus: w.status.name,
  };
}

export async function listExecutions(deps: ApiDeps, query: string, limit: number): Promise<WorkflowExecutionInfo[]> {
  const out: WorkflowExecutionInfo[] = [];
  for await (const w of deps.temporal.workflow.list({ query, pageSize: Math.min(limit, 100) })) {
    out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

const isoOrThrow = (v: string) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `invalid date: ${v}`);
  return d.toISOString();
};

/** Starts a TaskWorkflow (used by task creation and uploads). */
export async function startTaskWorkflow(
  deps: ApiDeps,
  user: Principal,
  input: Omit<TaskInput, 'agentId' | 'requestedBy' | 'trigger' | 'settings' | 'taskId'>,
  opts: { taskId?: string; trigger?: TaskTrigger } = {},
): Promise<string> {
  const { config } = deps;
  const taskId = opts.taskId ?? `task-${ulid()}`;
  const trigger: TaskTrigger = opts.trigger ?? { kind: 'user' };
  const full: TaskInput = { ...input, taskId, agentId: config.AGENT_ID, requestedBy: toIdentity(user), trigger, settings: taskSettings(deps) };
  await deps.temporal.workflow.start('taskWorkflow', {
    workflowId: taskId,
    taskQueue: config.taskQueue,
    args: [full],
    typedSearchAttributes: [
      { key: SA.AgentId, value: config.AGENT_ID },
      { key: SA.RequestedBy, value: user.upn },
      { key: SA.TaskType, value: input.type },
      { key: SA.TaskStatus, value: 'queued' },
      { key: SA.TaskTitle, value: input.title },
      { key: SA.Trigger, value: trigger.kind },
    ],
    staticSummary: input.title.slice(0, 200),
  });
  metrics.tasksStarted.add(1, { type: input.type });
  return taskId;
}

export function taskRouter(deps: ApiDeps): Router {
  const r = Router();
  const { config, temporal } = deps;
  const roles = config.roles;
  const timelineCache = new LRUCache<string, Timeline>({ max: 500 });

  const createLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.TASK_RATE_LIMIT_PER_HOUR,
    keyGenerator: (req) => (req as Request).user?.upn ?? 'anonymous',
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many tasks created, try again later' },
  });

  const handle = (id: string) => {
    if (!TASK_ID_PATTERN.test(id)) throw new HttpError(400, 'invalid task id');
    return temporal.workflow.getHandle(id);
  };

  r.post('/tasks', createLimiter, async (req, res) => {
    const body = createTaskBody.parse(req.body);
    const taskId = await startTaskWorkflow(deps, req.user!, {
      title: body.title,
      instructions: body.instructions,
      type: body.type,
      approval: body.approval,
      budget: { maxTokens: UNLIMITED_TOKENS }, // spend limit in USD per agent instead (ADR-0029)
    });
    res.status(201).json({ taskId });
  });

  r.get('/tasks', async (req, res) => {
    const f = listTasksQuery.parse(req.query);
    const clauses = [`AgentId = ${q(config.AGENT_ID)}`, `WorkflowType = 'taskWorkflow'`];
    if (f.status) {
      const list = f.status.split(',').filter(Boolean);
      clauses.push(list.length > 1 ? `TaskStatus IN (${list.map(q).join(',')})` : `TaskStatus = ${q(list[0]!)}`);
    }
    if (f.requestedBy) clauses.push(`RequestedBy = ${q(f.requestedBy === 'me' ? req.user!.upn : f.requestedBy.toLowerCase())}`);
    if (f.type) clauses.push(`TaskType = ${q(f.type)}`);
    if (f.from) clauses.push(`StartTime >= ${q(isoOrThrow(f.from))}`);
    if (f.to) clauses.push(`StartTime <= ${q(isoOrThrow(f.to))}`);
    if (f.pageToken) clauses.push(`StartTime < ${q(isoOrThrow(Buffer.from(f.pageToken, 'base64url').toString()))}`);
    const items = (await listExecutions(deps, clauses.join(' AND '), f.pageSize)).map(toListItem);
    const last = items[items.length - 1];
    res.json({ items, nextPageToken: items.length === f.pageSize && last ? Buffer.from(last.startTime).toString('base64url') : undefined });
  });

  r.get('/tasks/:id', async (req, res) => {
    const h = handle(req.params.id);
    try {
      const [state, d] = await Promise.all([h.query(taskStateQuery), h.describe()]);
      const detail: TaskDetail = {
        state,
        workflow: { runId: d.runId, status: d.status.name, startTime: d.startTime.toISOString(), closeTime: d.closeTime?.toISOString(), historyLength: d.historyLength },
        source: 'live',
      };
      return res.json(detail);
    } catch (err) {
      // Beyond Temporal retention: serve the permanent audit export (spec §9.2).
      const rel = await findAuditExport(deps, req.params.id);
      if (!rel) throw err;
      const exp = (await readAuditExport(config.workspaceDir, rel)) as { state: TaskState; workflowId: string; runId: string; exportedAt: string } | undefined;
      if (!exp) throw err;
      return res.json({ state: exp.state, workflow: { runId: exp.runId, status: 'ARCHIVED', startTime: exp.state.createdAt, closeTime: exp.exportedAt }, source: 'audit-export' } satisfies TaskDetail);
    }
  });

  r.post('/tasks/:id/decision', async (req, res) => {
    const body = decisionBody.parse(req.body);
    const h = handle(req.params.id);
    const state = await h.query(taskStateQuery);
    const isRequester = state.requestedBy.upn === req.user!.upn || (state.trigger.kind === 'schedule' && state.trigger.owner.upn === req.user!.upn);
    if (!isRequester && !req.user!.roles.includes(roles.approver)) throw new HttpError(403, 'Only approvers or the requester may decide');
    const updated = await h.executeUpdate(decideUpdate, { args: [{ decision: body.decision, comment: body.comment, by: req.user! }] });
    res.json(updated);
  });

  r.post('/tasks/:id/cancel', async (req, res) => {
    const body = cancelBody.parse(req.body ?? {});
    const h = handle(req.params.id);
    const state = await h.query(taskStateQuery);
    if (state.requestedBy.upn !== req.user!.upn && !req.user!.roles.includes(roles.admin)) {
      throw new HttpError(403, 'Only the requester or an admin may cancel');
    }
    res.json(await h.executeUpdate(cancelUpdate, { args: [{ by: req.user!, reason: body.reason }] }));
  });

  // Chat with the agent about the task (ADR-0030) — also for finished tasks
  const chat = new TaskChat(deps);
  r.get('/tasks/:id/chat', async (req, res) => {
    res.json(await chat.list(req.params.id));
  });
  r.post('/tasks/:id/chat', async (req, res) => {
    const body = taskChatBody.parse(req.body);
    const state = await loadTaskState(deps, req.params.id);
    res.status(201).json(await chat.ask(req.params.id, state, req.user!, body.text));
  });

  r.post('/tasks/:id/comments', async (req, res) => {
    const body = commentBody.parse(req.body);
    res.json(await handle(req.params.id).executeUpdate(commentUpdate, { args: [{ by: req.user!, text: body.text }] }));
  });

  async function taskTimeline(id: string): Promise<Timeline> {
    const cached = timelineCache.get(id);
    if (cached) return cached;
    const h = handle(id);
    try {
      const [history, d] = await Promise.all([h.fetchHistory(), h.describe()]);
      const tl = mapHistory(await decodeHistory(history, deps.codec), { laneId: id });
      if (d.status.name !== 'RUNNING') timelineCache.set(id, tl);
      return tl;
    } catch (err) {
      const rel = await findAuditExport(deps, id);
      const exp = rel ? ((await readAuditExport(config.workspaceDir, rel)) as { timeline?: Timeline } | undefined) : undefined;
      if (exp?.timeline) {
        timelineCache.set(id, exp.timeline);
        return exp.timeline;
      }
      throw err;
    }
  }

  r.get('/tasks/:id/timeline', async (req, res) => {
    res.json(await taskTimeline(req.params.id));
  });

  r.get('/timeline', async (req, res) => {
    const to = req.query.to ? isoOrThrow(String(req.query.to)) : new Date().toISOString();
    const from = req.query.from ? isoOrThrow(String(req.query.from)) : new Date(Date.now() - 86_400_000).toISOString();
    const query = `AgentId = ${q(config.AGENT_ID)} AND WorkflowType IN ('taskWorkflow','maintenanceWorkflow') AND StartTime <= ${q(to)} AND (CloseTime >= ${q(from)} OR ExecutionStatus = 'Running')`;
    const executions = await listExecutions(deps, query, 40);
    const timelines = await Promise.all(executions.map((w) => taskTimelineAny(w.workflowId, w.type).catch(() => undefined)));
    const merged = mergeTimelines(timelines.filter((t): t is Timeline => !!t), { id: agentWorkflowId(config.AGENT_ID), label: `${config.AGENT_DISPLAY_NAME} (workspace)` });
    res.json({ ...merged, range: { from, to } });
  });

  /** Maintenance workflows have ids that do not match the task pattern. */
  async function taskTimelineAny(id: string, type: string): Promise<Timeline> {
    if (type === 'taskWorkflow') return taskTimeline(id);
    const cached = timelineCache.get(id);
    if (cached) return cached;
    const h = temporal.workflow.getHandle(id);
    const tl = mapHistory(await decodeHistory(await h.fetchHistory(), deps.codec), { laneId: id, laneLabel: `Maintenance · ${id.split('-').slice(2, 3).join('')}` });
    tl.lanes[0]!.kind = 'schedule';
    timelineCache.set(id, tl);
    return tl;
  }

  /* -------------------------------------------------------------- live (SSE, spec §9.3) */
  r.get('/tasks/:id/live', (req, res) => {
    const taskId = req.params.id;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const send = (ev: { type: string }) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    for (const ev of deps.events.recentEvents(taskId)) send(ev);
    if (!deps.events.isTaskActive(taskId)) send({ type: 'idle', at: new Date().toISOString() } as never);
    const unsubscribe = deps.events.onTask(taskId, send);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  return r;
}

/** Task state from Temporal, or from the audit export once the workflow is beyond retention. */
export async function loadTaskState(deps: ApiDeps, taskId: string): Promise<TaskState> {
  try {
    return await deps.temporal.workflow.getHandle(taskId).query(taskStateQuery);
  } catch (err) {
    const rel = await findAuditExport(deps, taskId);
    const exp = rel ? ((await readAuditExport(deps.config.workspaceDir, rel)) as { state: TaskState } | undefined) : undefined;
    if (!exp) throw err;
    return exp.state;
  }
}

export async function findAuditExport(deps: ApiDeps, taskId: string): Promise<string | undefined> {
  if (!TASK_ID_PATTERN.test(taskId)) return undefined;
  const r = await deps.git.run(['ls-files', '--', `.agent/audit/*/*/${stepFileName(taskId)}.json`], { allowFail: true });
  return r.stdout.split('\n').find(Boolean);
}

