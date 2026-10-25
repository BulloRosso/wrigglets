import { z } from 'zod';
import type { Identity } from './identity.js';
import { APPROVAL_POLICIES } from './task.js';

export const SCHEDULE_TIMEZONE = 'Europe/Berlin';

const hour = z.number().int().min(0).max(23);
const minute = z.number().int().min(0).max(59);

export const calendarSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), hour, minute }),
  z.object({ kind: z.literal('weekly'), dayOfWeek: z.number().int().min(0).max(6), hour, minute }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(28), hour, minute }),
  z.object({ kind: z.literal('cron'), cron: z.string().trim().min(9).max(120) }),
  z.object({ kind: z.literal('once'), at: z.string().datetime({ offset: true }) }),
]);
export type CalendarSpec = z.infer<typeof calendarSpec>;

export const createScheduleBody = z.object({
  title: z.string().trim().min(3).max(120),
  instructions: z.string().trim().min(1).max(20_000),
  type: z.enum(['analysis', 'change', 'report']),
  approval: z.enum(APPROVAL_POLICIES).default('deviation'),
  calendar: calendarSpec,
});
export type CreateScheduleBody = z.infer<typeof createScheduleBody>;

export const patchScheduleBody = z.object({
  paused: z.boolean().optional(),
  title: z.string().trim().min(3).max(120).optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  approval: z.enum(APPROVAL_POLICIES).optional(),
  calendar: calendarSpec.optional(),
  note: z.string().max(500).optional(),
});
export type PatchScheduleBody = z.infer<typeof patchScheduleBody>;

export interface ScheduleHistoryEntry {
  at: string;
  by: Identity;
  action: 'created' | 'updated' | 'paused' | 'resumed' | 'triggered';
  note?: string;
}

export interface ScheduleMemo {
  owner: Identity;
  createdBy: Identity;
  createdAt: string;
  calendar: CalendarSpec;
  history: ScheduleHistoryEntry[];
}

export interface ScheduleDto {
  scheduleId: string;
  system: boolean;
  title: string;
  instructions?: string;
  type: string;
  approval?: string;
  calendar?: CalendarSpec;
  cron?: string[];
  timezone: string;
  paused: boolean;
  note?: string;
  owner?: Identity;
  nextRuns: string[];
  recentRuns: Array<{ workflowId: string; startedAt: string; status?: string }>;
  history: ScheduleHistoryEntry[];
}

/** Converts the UI calendar choice into a cron expression (minute hour dom month dow). */
export function calendarToCron(c: CalendarSpec): string | undefined {
  switch (c.kind) {
    case 'daily':
      return `${c.minute} ${c.hour} * * *`;
    case 'weekly':
      return `${c.minute} ${c.hour} * * ${c.dayOfWeek}`;
    case 'monthly':
      return `${c.minute} ${c.hour} ${c.dayOfMonth} * *`;
    case 'cron':
      return c.cron;
    case 'once':
      return undefined;
  }
}

export function describeCalendar(c: CalendarSpec): string {
  const t = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  switch (c.kind) {
    case 'daily':
      return `Daily at ${t(c.hour, c.minute)}`;
    case 'weekly':
      return `Every ${days[c.dayOfWeek]} at ${t(c.hour, c.minute)}`;
    case 'monthly':
      return `Monthly on day ${c.dayOfMonth} at ${t(c.hour, c.minute)}`;
    case 'cron':
      return `Cron: ${c.cron}`;
    case 'once':
      return `Once at ${new Date(c.at).toLocaleString()}`;
  }
}
