import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DelegationStatus } from '@cw/shared';
import { DelegationQueue, isQueueId, type QueuedDelegation } from './delegationQueue.js';

const input = (instructions: string) => ({ title: 'Task', instructions, type: 'change' as const, approval: 'plan' as const });

let remote: Record<string, Partial<DelegationStatus>>;
let sent: Array<{ q: QueuedDelegation; instructions: string }>;
let blocked: string | undefined;
let dir: string;
let queue: DelegationQueue;

const make = async () => {
  const q = new DelegationQueue(path.join(dir, 'q.json'), {
    remoteStatus: async (_from, ref) => ({ agentId: ref.agentId, taskId: ref.taskId, state: 'working', terminal: false, ...remote[ref.taskId] }) as DelegationStatus,
    dispatch: async (item, instructions) => {
      sent.push({ q: item, instructions });
      remote[`remote-${sent.length}`] = { state: 'working', terminal: false };
      return { taskId: `remote-${sent.length}` };
    },
    blocked: () => blocked,
  });
  await q.load();
  return q;
};

beforeEach(async () => {
  remote = { 'lara-1': { state: 'working', terminal: false } };
  sent = [];
  blocked = undefined;
  dir = await mkdtemp(path.join(os.tmpdir(), 'dq-'));
  queue = await make();
  await queue.remember('max', { agentId: 'lara', taskId: 'lara-1' });
});

describe('ordered delegation', () => {
  it('holds a task back until its predecessor completed, then sends it with the result', async () => {
    const q = await queue.add({ from: 'max', to: 'horst', input: input('Inform the customers.'), after: ['lara-1'] });
    expect(isQueueId(q.id)).toBe(true);
    expect((await queue.status(q.id)).state).toBe('submitted');
    expect(sent).toHaveLength(0);

    remote['lara-1'] = { state: 'completed', terminal: true, result: 'PO-4430 arrives 2026-10-09' };
    const s = await queue.status(q.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.instructions).toContain('Inform the customers.');
    expect(sent[0]!.instructions).toContain('PO-4430 arrives 2026-10-09');
    expect(s.taskId).toBe(q.id); // the caller keeps following the queue id
    expect(s.terminal).toBe(false);

    remote['remote-1'] = { state: 'completed', terminal: true, result: 'notices sent' };
    expect(await queue.status(q.id)).toMatchObject({ state: 'completed', terminal: true, result: 'notices sent', taskId: q.id });
  });

  it('never sends the same task twice', async () => {
    remote['lara-1'] = { state: 'completed', terminal: true, result: 'ok' };
    const q = await queue.add({ from: 'max', to: 'horst', input: input('x'), after: ['lara-1'] });
    await Promise.all([queue.status(q.id), queue.status(q.id), queue.status(q.id)]);
    expect(sent).toHaveLength(1);
  });

  it('does not start a task whose predecessor failed', async () => {
    const q = await queue.add({ from: 'max', to: 'horst', input: input('x'), after: ['lara-1'] });
    remote['lara-1'] = { state: 'rejected', terminal: true, summary: 'the plan was rejected' };
    expect(await queue.status(q.id)).toMatchObject({ state: 'canceled', terminal: true });
    expect((await queue.status(q.id)).summary).toMatch(/ended as rejected/);
    expect(sent).toHaveLength(0);
  });

  it('keeps a chain in order: A, then B after A, then C after B', async () => {
    const b = await queue.add({ from: 'max', to: 'cora', input: input('replan'), after: ['lara-1'] });
    const c = await queue.add({ from: 'max', to: 'horst', input: input('notices'), after: [b.id] });
    remote['lara-1'] = { state: 'working', terminal: false };
    await queue.status(c.id);
    expect(sent).toHaveLength(0);

    remote['lara-1'] = { state: 'completed', terminal: true, result: 'part ordered' };
    await queue.status(c.id); // advances b; c still waits for b
    expect(sent.map((s) => s.q.to)).toEqual(['cora']);
    expect((await queue.status(c.id)).state).toBe('submitted');

    remote['remote-1'] = { state: 'completed', terminal: true, result: 'new dates: 2026-10-19' };
    await queue.status(c.id);
    expect(sent.map((s) => s.q.to)).toEqual(['cora', 'horst']);
    expect(sent[1]!.instructions).toContain('new dates: 2026-10-19');
  });

  it('a cancelled link cancels everything behind it', async () => {
    const b = await queue.add({ from: 'max', to: 'cora', input: input('replan'), after: ['lara-1'] });
    const c = await queue.add({ from: 'max', to: 'horst', input: input('notices'), after: [b.id] });
    remote['lara-1'] = { state: 'failed', terminal: true };
    expect((await queue.status(c.id)).state).toBe('canceled');
    expect(sent).toHaveLength(0);
  });

  it('refuses ids that are not the caller\'s own delegations', async () => {
    await expect(queue.add({ from: 'tom', to: 'horst', input: input('x'), after: ['lara-1'] })).rejects.toThrow(/not a task you delegated/);
    await expect(queue.add({ from: 'max', to: 'horst', input: input('x'), after: [] })).rejects.toThrow(/between 1 and/);
  });

  it('respects the policy at start time (colleague paused in the meantime)', async () => {
    const q = await queue.add({ from: 'max', to: 'horst', input: input('x'), after: ['lara-1'] });
    remote['lara-1'] = { state: 'completed', terminal: true, result: 'ok' };
    blocked = 'Agent horst is currently paused.';
    expect(await queue.status(q.id)).toMatchObject({ state: 'canceled' });
    expect(sent).toHaveLength(0);
  });

  it('survives a restart', async () => {
    const q = await queue.add({ from: 'max', to: 'horst', input: input('x'), after: ['lara-1'] });
    const again = await make();
    remote['lara-1'] = { state: 'completed', terminal: true, result: 'ok' };
    await again.status(q.id);
    expect(sent).toHaveLength(1);
  });
});
