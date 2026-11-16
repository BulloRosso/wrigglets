import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventFeed, eventIdOf, type FeedEvent, type FeedSources } from './eventFeed.js';

let dir: string;
let appended: FeedEvent[];
let fail = false;
const admin: Array<{ at: string; by: string; action: string; target: string }> = [];
const gateway: Array<{ at: string; agentId: string; tool: string; outcome: string; policy?: string }> = [];
const agent: Array<{ at: string; by: string; action: string; target: string }> = [];
const src: FeedSources = {
  adminAudit: async () => [...admin].reverse(),
  gatewayAudit: async () => gateway,
  agents: () => ['sofa-max'],
  agentAudit: async (_a, since) => agent.filter((e) => e.at > since),
  append: async (e) => {
    if (fail) throw new Error('core down');
    appended.push(...e);
  },
  enabled: () => true,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cw-feed-'));
  appended = [];
  fail = false;
  admin.length = gateway.length = agent.length = 0;
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('event feed', () => {
  it('forwards admin, gateway and agent audit as events from the first start on, once', async () => {
    admin.push({ at: '2000-01-01T00:00:00.000Z', by: 'old@x', action: 'agent.create', target: 'x' }); // before the feed existed
    const f = new EventFeed(dir, src);
    await f.load();
    const t = new Date(Date.now() + 1000).toISOString();
    admin.push({ at: t, by: 'ada@x', action: 'gateway.allow', target: 'sofa-max' });
    gateway.push({ at: t, agentId: 'sofa-max', tool: 'erp__get_kpi', outcome: 'denied', policy: 'opa' });
    agent.push({ at: t, by: 'paula@x', action: 'schedule.update', target: 'daily' });
    expect(await f.tick()).toBe(3);
    expect(appended.map((e) => e.type)).toEqual(['AdminAction', 'GatewayToolCall', 'AgentAppAction']);
    expect(appended[1]).toMatchObject({ actorAgent: 'sofa-max', objectId: 'erp__get_kpi', occurredAt: t, payload: { outcome: 'denied', policy: 'opa' } });
    expect(await f.tick()).toBe(0);
    // a restart keeps the cursors
    const g = new EventFeed(dir, src);
    await g.load();
    expect(await g.tick()).toBe(0);
  });

  it('keeps the cursor when the event log is down and catches up; event ids are deterministic', async () => {
    const f = new EventFeed(dir, src);
    await f.load();
    fail = true;
    gateway.push({ at: new Date(Date.now() + 1000).toISOString(), agentId: 'a', tool: 't', outcome: 'ok' });
    expect(await f.tick()).toBe(0);
    expect(f.last?.error).toMatch(/core down/);
    fail = false;
    expect(await f.tick()).toBe(1);
    expect(eventIdOf('gateway', gateway[0])).toBe(appended[0]!.eventId);
    expect(appended[0]!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
