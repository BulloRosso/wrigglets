import { Router } from 'express';
import { ScheduleNotFoundError, ScheduleOverlapPolicy, type ScheduleDescription, type ScheduleOptions, type ScheduleSpec } from '@temporalio/client';
import {
  SCHEDULE_TIMEZONE,
  calendarToCron,
  createScheduleBody,
  patchScheduleBody,
  scheduledTaskIdPrefix,
  slugify,
  toIdentity,
  userScheduleId,
  type CalendarSpec,
  type ScheduleDto,
  type ScheduleMemo,
  type TaskInput,
} from '@cw/shared';
import { SA } from '@cw/shared/search-attributes';
import { HttpError, type ApiDeps } from '../context.js';
import { taskSettings } from './tasks.js';

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'] as const;

export function toScheduleSpec(c: CalendarSpec): ScheduleSpec {
  if (c.kind === 'once') {
    const d = new Date(c.at);
    return {
      calendars: [{ year: d.getUTCFullYear(), month: MONTHS[d.getUTCMonth()], dayOfMonth: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0 }],
      timezone: 'UTC',
    };
  }
  return { cronExpressions: [calendarToCron(c)!], timezone: SCHEDULE_TIMEZONE };
}

/**
 * Schedules for future work (spec §7.7). Temporal does not allow updating a schedule's memo,
 * so the change history lives in the application audit log (ADR-0010).
 */
export function scheduleRouter(deps: ApiDeps): Router {
  const r = Router();
  const { config, temporal } = deps;
  const prefix = `sched-${config.AGENT_ID}-`;
  const sysPrefix = `sched-sys-${config.AGENT_ID}-`;
  const isOwn = (id: string) => id.startsWith(prefix) || id.startsWith(sysPrefix);

  async function toDto(id: string, d: ScheduleDescription): Promise<ScheduleDto> {
    const memo = (d.memo ?? {}) as Partial<ScheduleMemo> & { system?: boolean; title?: string; cron?: string };
    const action = d.action as { args?: unknown[]; workflowType?: string };
    const input = (action.args?.[0] ?? {}) as Partial<TaskInput>;
    const history = await deps.audit.find((e) => e.target === id && e.action.startsWith('schedule.'), 50);
    return {
      scheduleId: id,
      system: id.startsWith(sysPrefix),
      title: input.title ?? memo.title ?? id,
      instructions: input.instructions,
      type: input.type ?? 'maintenance',
      approval: input.approval,
      calendar: memo.calendar,
      cron: memo.cron ? [memo.cron] : memo.calendar && memo.calendar.kind !== 'once' ? [calendarToCron(memo.calendar)!] : undefined,
      timezone: d.spec.timezone ?? SCHEDULE_TIMEZONE,
      paused: d.state.paused,
      note: d.state.note,
      owner: memo.owner,
      nextRuns: d.info.nextActionTimes.slice(0, 5).map((t) => t.toISOString()),
      recentRuns: d.info.recentActions
        .slice(-10)
        .reverse()
        .map((a) => ({ workflowId: (a.action as { workflow?: { workflowId: string } }).workflow?.workflowId ?? '', startedAt: a.takenAt.toISOString() })),
      history: history.map((e) => ({ at: e.at, by: { upn: e.by, name: e.by, oid: '' }, action: e.action.replace('schedule.', '') as ScheduleDto['history'][number]['action'], note: (e.details?.note as string | undefined) ?? undefined })),
    };
  }

  const handleFor = (id: string) => {
    if (!isOwn(id)) throw new HttpError(404, 'schedule not found');
    return temporal.schedule.getHandle(id);
  };

  async function ensureMayEdit(id: string, d: ScheduleDescription, upn: string, roles: string[]) {
    const isAdmin = roles.includes(config.roles.admin);
    if (id.startsWith(sysPrefix) && !isAdmin) throw new HttpError(403, 'System schedules can only be changed by admins');
    const owner = (d.memo as Partial<ScheduleMemo> | undefined)?.owner?.upn;
    if (!isAdmin && owner !== upn) throw new HttpError(403, 'Only the owner or an admin may change this schedule');
  }

  r.get('/schedules', async (_req, res) => {
    const ids: string[] = [];
    for await (const s of temporal.schedule.list()) if (isOwn(s.scheduleId)) ids.push(s.scheduleId);
    const dtos = await Promise.all(ids.map(async (id) => toDto(id, await temporal.schedule.getHandle(id).describe())));
    dtos.sort((a, b) => Number(a.system) - Number(b.system) || a.title.localeCompare(b.title));
    res.json(dtos);
  });

  r.get('/schedules/:id', async (req, res) => {
    res.json(await toDto(req.params.id, await handleFor(req.params.id).describe()));
  });

  r.post('/schedules', async (req, res) => {
    const body = createScheduleBody.parse(req.body);
    const user = req.user!;
    const owner = toIdentity(user);
    let scheduleId = userScheduleId(config.AGENT_ID, slugify(body.title));
    for (let i = 2; ; i++) {
      try {
        await temporal.schedule.getHandle(scheduleId).describe();
        scheduleId = `${userScheduleId(config.AGENT_ID, slugify(body.title))}-${i}`;
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) break;
        throw err;
      }
    }
    const input: TaskInput = {
      agentId: config.AGENT_ID,
      title: body.title,
      instructions: body.instructions,
      type: body.type,
      requestedBy: owner,
      trigger: { kind: 'schedule', scheduleId, owner },
      approval: body.approval,
      budget: { maxTokens: body.maxTokens ?? config.TASK_DEFAULT_TOKEN_BUDGET },
      settings: taskSettings(deps),
    };
    const memo: ScheduleMemo = { owner, createdBy: owner, createdAt: new Date().toISOString(), calendar: body.calendar, history: [] };
    const options: ScheduleOptions = {
      scheduleId,
      spec: toScheduleSpec(body.calendar),
      action: {
        type: 'startWorkflow',
        workflowType: 'taskWorkflow',
        workflowId: scheduledTaskIdPrefix(scheduleId),
        taskQueue: config.taskQueue,
        args: [input],
        typedSearchAttributes: [
          { key: SA.AgentId, value: config.AGENT_ID },
          { key: SA.RequestedBy, value: owner.upn },
          { key: SA.TaskType, value: body.type },
          { key: SA.TaskStatus, value: 'queued' },
          { key: SA.TaskTitle, value: body.title },
          { key: SA.Trigger, value: 'schedule' },
          { key: SA.ScheduleId, value: scheduleId },
        ],
        staticSummary: body.title,
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour' },
      memo: memo as unknown as Record<string, unknown>,
      typedSearchAttributes: [
        { key: SA.AgentId, value: config.AGENT_ID },
        { key: SA.RequestedBy, value: owner.upn },
      ],
      state: body.calendar.kind === 'once' ? { remainingActions: 1, note: `created by ${owner.upn}` } : { note: `created by ${owner.upn}` },
    };
    await temporal.schedule.create(options);
    await deps.audit.write({ by: user.upn, action: 'schedule.created', target: scheduleId, details: { title: body.title, calendar: body.calendar } });
    res.status(201).json({ scheduleId });
  });

  r.patch('/schedules/:id', async (req, res) => {
    const body = patchScheduleBody.parse(req.body);
    const h = handleFor(req.params.id);
    const d = await h.describe();
    await ensureMayEdit(req.params.id, d, req.user!.upn, req.user!.roles);
    const note = body.note ?? `changed by ${req.user!.upn}`;
    if (body.title || body.instructions || body.approval || body.calendar) {
      await h.update((prev) => {
        const prevInput = (prev.action.args?.[0] ?? {}) as TaskInput;
        const nextInput: TaskInput = {
          ...prevInput,
          title: body.title ?? prevInput.title,
          instructions: body.instructions ?? prevInput.instructions,
          approval: body.approval ?? prevInput.approval,
        };
        return {
          ...prev,
          spec: body.calendar ? toScheduleSpec(body.calendar) : prev.spec,
          action: { ...prev.action, args: [nextInput] },
          state: { ...prev.state, note },
        } as never;
      });
      await deps.audit.write({ by: req.user!.upn, action: 'schedule.updated', target: req.params.id, details: { ...body, note } });
    }
    if (body.paused === true) {
      await h.pause(note);
      await deps.audit.write({ by: req.user!.upn, action: 'schedule.paused', target: req.params.id, details: { note } });
    } else if (body.paused === false) {
      await h.unpause(note);
      await deps.audit.write({ by: req.user!.upn, action: 'schedule.resumed', target: req.params.id, details: { note } });
    }
    res.json(await toDto(req.params.id, await h.describe()));
  });

  r.post('/schedules/:id/trigger', async (req, res) => {
    const h = handleFor(req.params.id);
    const d = await h.describe();
    await ensureMayEdit(req.params.id, d, req.user!.upn, req.user!.roles);
    await h.trigger(ScheduleOverlapPolicy.ALLOW_ALL);
    await deps.audit.write({ by: req.user!.upn, action: 'schedule.triggered', target: req.params.id });
    res.status(202).json({ triggered: true });
  });

  r.delete('/schedules/:id', async (req, res) => {
    const h = handleFor(req.params.id);
    const d = await h.describe();
    await ensureMayEdit(req.params.id, d, req.user!.upn, req.user!.roles);
    await h.delete();
    await deps.audit.write({ by: req.user!.upn, action: 'schedule.deleted', target: req.params.id });
    res.status(204).end();
  });

  return r;
}
