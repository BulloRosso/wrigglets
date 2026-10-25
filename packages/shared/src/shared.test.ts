import { describe, expect, it } from 'vitest';
import { TASK_ID_PATTERN, calendarToCron, createScheduleBody, decisionBody, parseDuration, slugify, stepFileName, workspacePaths } from './index.js';

describe('shared helpers', () => {
  it('parses durations', () => {
    expect(parseDuration('4h')).toBe(14_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration(250)).toBe(250);
    expect(() => parseDuration('soon')).toThrow();
    expect(() => parseDuration('4x')).toThrow();
  });

  it('builds file-system safe paths from task and step ids', () => {
    const id = 'task-sched-max-m-2026-10-25T00:41:46Z';
    expect(TASK_ID_PATTERN.test(id)).toBe(true);
    expect(stepFileName(`${id}:run:1`)).toBe('task-sched-max-m-2026-10-25T00_41_46Z_run_1');
    expect(workspacePaths.plan(id)).toBe('.agent/plans/task-sched-max-m-2026-10-25T00_41_46Z.md');
    expect(workspacePaths.audit(id, new Date('2026-03-05T10:00:00Z'))).toBe('.agent/audit/2026/03/task-sched-max-m-2026-10-25T00_41_46Z.json');
  });

  it('slugifies titles', () => {
    expect(slugify('Monatliche Angebotsauswertung (Ü)')).toBe('monatliche-angebotsauswertung-u');
    expect(slugify('***')).toBe('schedule');
  });

  it('converts calendar choices to cron', () => {
    expect(calendarToCron({ kind: 'monthly', dayOfMonth: 1, hour: 7, minute: 0 })).toBe('0 7 1 * *');
    expect(calendarToCron({ kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 30 })).toBe('30 9 * * 1');
    expect(calendarToCron({ kind: 'once', at: '2026-11-01T06:00:00Z' })).toBeUndefined();
    expect(createScheduleBody.safeParse({ title: 'abc', instructions: 'x', type: 'report', calendar: { kind: 'daily', hour: 25, minute: 0 } }).success).toBe(false);
  });

  it('requires a comment to reject or request changes', () => {
    expect(decisionBody.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(decisionBody.safeParse({ decision: 'reject' }).success).toBe(false);
    expect(decisionBody.safeParse({ decision: 'revise', comment: 'more detail' }).success).toBe(true);
  });
});
