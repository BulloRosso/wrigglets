import { describe, expect, it } from 'vitest';
import { effectiveKillSwitch, maxLevel, moodForAgent, moodForTaskStatus, setKillSwitchBody, toolAllowed, type KillSwitchState } from './index.js';

const entry = (level: KillSwitchState['global']['level']) => ({ level, by: 'admin', at: '2026-10-25T00:00:00Z', reason: 'test' });

describe('kill switch', () => {
  it('takes the stricter of global and agent level', () => {
    expect(maxLevel('tools_off', 'paused', 'normal')).toBe('paused');
    const state: KillSwitchState = { global: entry('tools_off'), agents: { max: entry('stopped'), lara: entry('normal') } };
    expect(effectiveKillSwitch(state, 'max')).toMatchObject({ level: 'stopped', source: 'agent' });
    expect(effectiveKillSwitch(state, 'lara')).toMatchObject({ level: 'tools_off', source: 'global' });
    expect(effectiveKillSwitch({ global: entry('normal'), agents: {} }, 'x')).toEqual({ level: 'normal', source: 'none' });
  });

  it('requires a reason unless the level is normal', () => {
    expect(setKillSwitchBody.safeParse({ level: 'paused' }).success).toBe(false);
    expect(setKillSwitchBody.safeParse({ level: 'paused', reason: 'incident' }).success).toBe(true);
    expect(setKillSwitchBody.safeParse({ level: 'normal' }).success).toBe(true);
  });
});

describe('gateway allow-list', () => {
  it('matches exact names and wildcards', () => {
    expect(toolAllowed(['demo__fx_rate'], 'demo__fx_rate')).toBe(true);
    expect(toolAllowed(['demo__*'], 'demo__supplier_lookup')).toBe(true);
    expect(toolAllowed(['demo__*'], 'erp__post')).toBe(false);
    expect(toolAllowed([], 'demo__fx_rate')).toBe(false);
  });
});

describe('portrait moods', () => {
  it('maps task and agent states', () => {
    expect(moodForTaskStatus('completed')).toBe('happy');
    expect(moodForTaskStatus('failed')).toBe('fearful');
    expect(moodForTaskStatus('awaiting_approval')).toBe('doubt');
    expect(moodForTaskStatus('running')).toBe('neutral');
    expect(moodForAgent({ healthy: true, busy: false })).toBe('happy');
    expect(moodForAgent({ healthy: true, busy: true, killSwitch: 'paused' })).toBe('fearful');
    expect(moodForAgent({ healthy: true, busy: true, killSwitch: 'tools_off' })).toBe('doubt');
  });
});
