import { SIGNALS_LIMITS } from '@cw/shared';

const DAY = 86_400_000;

/**
 * Due dates the platform accepts: not further than SIGNALS_LIMITS.maxHorizonDays ahead (undefined = refuse).
 * A due date in the past becomes `now`: the expectation is overdue and signals right away.
 */
export function clampDueAt(dueAt: string, now: number): string | undefined {
  const t = Date.parse(dueAt);
  if (!Number.isFinite(t)) return undefined;
  if (t > now + SIGNALS_LIMITS.maxHorizonDays * DAY) return undefined;
  return new Date(Math.max(t, now)).toISOString();
}

/** Expectation ids are derived from the observation workflow id, so a retried observation never duplicates them. */
export function expectationIdFor(observationWorkflowId: string, index: number): string {
  return `sig-exp-${observationWorkflowId.replace(/^sig-obs-/, '')}-${index + 1}`;
}
