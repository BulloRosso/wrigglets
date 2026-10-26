import { ScheduleNotFoundError, ScheduleOverlapPolicy, type ScheduleOptions, type ScheduleSpec } from '@temporalio/client';
import {
  UNLIMITED_TOKENS,
  SCHEDULE_TIMEZONE,
  calendarToCron,
  scheduledTaskIdPrefix,
  slugify,
  userScheduleId,
  type CalendarSpec,
  type CreateScheduleBody,
  type Identity,
  type ScheduleMemo,
  type TaskInput,
} from '@cw/shared';
import { SA } from '@cw/shared/search-attributes';
import type { ApiDeps } from '../api/context.js';
import { taskSettings } from '../api/routes/tasks.js';

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
 * Creates the Temporal Schedule for a recurring task owned by `owner`. Shared by `POST /schedules` and by the approval
 * of a schedule the agent proposed in the chat (ADR-0034): this is the only place that creates user schedules, and it
 * is only ever called on behalf of an authenticated person.
 */
export async function createUserSchedule(deps: ApiDeps, body: CreateScheduleBody, owner: Identity, audit?: Record<string, unknown>): Promise<string> {
  const { config, temporal } = deps;
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
    budget: { maxTokens: UNLIMITED_TOKENS }, // spend limit in USD per agent instead (ADR-0029)
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
  await deps.audit.write({ by: owner.upn, action: 'schedule.created', target: scheduleId, details: { title: body.title, calendar: body.calendar, ...audit } });
  return scheduleId;
}
