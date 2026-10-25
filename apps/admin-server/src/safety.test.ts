import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFETY_RULES } from '@cw/shared';
import { evaluate } from './safety.js';

const rule = (id: string) => DEFAULT_SAFETY_RULES.find((r) => r.id === id)!;

describe('safety rule evaluation', () => {
  it('reads the counter that belongs to each rule kind', () => {
    const agent = { at: '', tokensLastHour: 2_500_000, permissionViolations: 1, stepFailuresLastHour: 0 };
    const gateway = { callsLastMinute: 7, callsLastHour: 30, deniedOrFailedLast10Min: 21 };
    expect(evaluate(rule('permission-violation'), { agent })).toBe(1);
    expect(evaluate(rule('token-spike'), { agent })).toBe(2_500_000);
    expect(evaluate(rule('tool-denials'), { gateway })).toBe(21);
    expect(evaluate(rule('tool-rate'), { gateway })).toBe(7);
    expect(evaluate(rule('failed-streak'), { failedStreak: 5 })).toBe(5);
  });

  it('returns undefined when the source is unavailable (no trip on missing data)', () => {
    expect(evaluate(rule('token-spike'), {})).toBeUndefined();
    expect(evaluate(rule('tool-rate'), {})).toBeUndefined();
  });
});
