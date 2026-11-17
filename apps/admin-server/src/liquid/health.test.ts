import { describe, expect, it } from 'vitest';
import { liquidHealth, type HealthDeps } from './health.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const at = (sAgo: number) => new Date(NOW - sAgo * 1000).toISOString();

const healthy = (): HealthDeps => ({
  now: () => NOW,
  services: async () => [{ name: 'ontology-db', state: 'running' }, { name: 'ontology-server', state: 'running' }],
  policy: async () => ({ bundle: { revision: 'rev-1234abcd' }, compileError: null, consumers: { gateway: { at: at(3), revision: 'rev-1234abcd' }, core: { at: at(4), revision: 'rev-1234abcd' } }, overlays: [] }),
  core: async () => ({ events: { maxSeq: 500 }, dispatcher: { cursor: 500, updatedAt: at(10), lag: 0 }, lake: { hwm: 480, lag: 20, lastFlush: null, error: null }, policy: { revision: 'rev-1234abcd', loadedAt: at(30) }, ontology: { name: 'sofa', version: '5.1.0' } }),
  config: async () => ({ initialized: true, inSync: true, lastReconcile: { at: at(20), ok: true, errors: [] }, pendingProposals: 0 }),
  gitHost: async () => ({ ready: true, setUp: true, stats: { okAt: at(5), retries: 0 } }),
  jobs: () => [{ id: 'reconcile', label: 'Config reconciler', everyMs: 60_000, runs: 3, lastRunAt: at(20), lastOkAt: at(20), skipped: 0 }, { id: 'event-feed', label: 'Audit into the event log', everyMs: 5_000, runs: 40, lastRunAt: at(3), lastOkAt: at(3), skipped: 0 }],
  inbox: async () => [],
  held: async () => [],
  killSwitch: () => ({ level: 'normal' }),
  playbookRuns: async () => [],
  apps: () => [{ id: 'dd', status: 'active', expiresAt: new Date(NOW + 100 * 86_400_000).toISOString() }],
});

describe('control loop health (ADR-0051)', () => {
  it('everything running: ok, one item per part', async () => {
    const h = await liquidHealth(healthy());
    expect(h.status).toBe('ok');
    expect(h.items.map((i) => i.id)).toEqual(['services', 'policy', 'core', 'reconcile', 'git-host', 'jobs', 'decisions', 'tightening', 'apps']);
    expect(h.items.every((i) => i.status === 'ok')).toBe(true);
  });

  it('a consumer on an old policy package is a warning (it keeps its last package)', async () => {
    const d = healthy();
    d.policy = async () => ({ bundle: { revision: 'rev-new00000' }, compileError: null, consumers: { gateway: { at: at(3), revision: 'rev-new00000' }, core: { at: at(3), revision: 'rev-1234abcd' } }, overlays: [] });
    const p = (await liquidHealth(d)).items.find((i) => i.id === 'policy')!;
    expect(p).toMatchObject({ status: 'warn' });
    expect(p.detail).toContain('core on rev-1234');
  });

  it('a stuck dispatcher fails; a failing probe fails alone and does not hide the others', async () => {
    const d = healthy();
    d.core = async () => ({ events: { maxSeq: 900 }, dispatcher: { cursor: 500, updatedAt: at(600), lag: 400 }, lake: { hwm: 900, lag: 0, lastFlush: null, error: null }, policy: { revision: 'r', loadedAt: at(1) }, ontology: { name: 'sofa', version: '5.1.0' } });
    d.config = async () => {
      throw new Error('repository locked');
    };
    const h = await liquidHealth(d);
    expect(h.status).toBe('fail');
    expect(h.items.find((i) => i.id === 'core')).toMatchObject({ status: 'fail' });
    expect(h.items.find((i) => i.id === 'core')!.detail).toContain('400 events behind');
    expect(h.items.find((i) => i.id === 'reconcile')).toMatchObject({ status: 'fail', detail: 'repository locked' });
    expect(h.items.find((i) => i.id === 'services')).toMatchObject({ status: 'ok' });
  });

  it('tightening a person left in force and old decisions are listed as warnings', async () => {
    const d = healthy();
    d.held = async () => [{ workflowId: 'PurchaseOrderRelease-1', refs: ['console-abc'] }];
    d.killSwitch = () => ({ level: 'tools_off', reason: 'tool denials' });
    d.inbox = async () => [{ kind: 'action', createdAt: at(5 * 86_400), decideHere: true }];
    const h = await liquidHealth(d);
    expect(h.items.find((i) => i.id === 'tightening')!.detail).toMatch(/kill switch tools_off.*1 business workflow\(s\) held \(console-abc\)/);
    expect(h.items.find((i) => i.id === 'decisions')).toMatchObject({ status: 'warn' });
    expect(h.status).toBe('warn');
  });

  it('a failing job fails the jobs item; a job without a run for three intervals is a warning', async () => {
    const d = healthy();
    d.jobs = () => [
      { id: 'event-feed', label: 'Audit into the event log', everyMs: 5_000, runs: 9, lastRunAt: at(2), lastOkAt: at(60), lastError: 'event log unreachable', lastErrorAt: at(2), skipped: 0 },
    ];
    expect((await liquidHealth(d)).items.find((i) => i.id === 'jobs')).toMatchObject({ status: 'fail', detail: expect.stringContaining('event log unreachable') });
    d.jobs = () => [{ id: 'reconcile', label: 'Config reconciler', everyMs: 60_000, runs: 2, lastRunAt: at(400), lastOkAt: at(400), skipped: 0 }];
    expect((await liquidHealth(d)).items.find((i) => i.id === 'jobs')).toMatchObject({ status: 'warn' });
  });
});
