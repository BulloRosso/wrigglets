import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, WikiError, WikiStore, checkPath } from './store.js';

let store: WikiStore;
beforeEach(async () => {
  store = new WikiStore(await mkdtemp(path.join(os.tmpdir(), 'wiki-')));
  await store.load();
});

const prop = (over: Record<string, unknown> = {}) => ({ path: 'lessons/express.md', content: '# Express\nUse express for repair-critical parts.', reason: 'Seen in task 42: express shortened the repair', agent: 'sofa-lara', task: 'task-42', ...over });

describe('company wiki store', () => {
  it('accepts only safe page paths', () => {
    expect(checkPath('protocols/handoff.md')).toBe('protocols/handoff.md');
    for (const bad of ['../x.md', '/etc/passwd.md', 'a.txt', 'A.md', 'a/b/c/d/e/f.md', '.git/config.md', 'a b.md', '']) expect(() => checkPath(bad)).toThrow(WikiError);
  });

  it('agents can only propose: nothing changes before a person decides', async () => {
    const p = await store.propose(prop());
    expect(p.status).toBe('pending');
    expect(store.read('lessons/express.md')).toBeUndefined();
    expect(store.list()).toHaveLength(0);
    expect(store.proposals({ status: 'pending' })).toHaveLength(1);
  });

  it('approval publishes the page with provenance; the old version stays', async () => {
    await store.put('lessons/express.md', '# Express\nOld text', 'Paula');
    const p = await store.propose(prop());
    await store.decide(p.id, 'approve', 'Paula', 'Good, evidence is clear');
    const page = store.read('lessons/express.md')!;
    expect(page.content).toContain('repair-critical');
    expect(page.updatedBy).toBe('Paula');
    expect(page.versions).toBe(1);
    expect(store.version('lessons/express.md', 0)?.content).toContain('Old text');
    expect(store.proposals({ status: 'approved' })[0]).toMatchObject({ decidedBy: 'Paula', comment: 'Good, evidence is clear' });
  });

  it('a reviewer can approve a corrected text', async () => {
    const p = await store.propose(prop());
    await store.decide(p.id, 'approve', 'Stefan', undefined, '# Express\nOnly if the KPI improves.');
    expect(store.read('lessons/express.md')!.content).toContain('Only if the KPI improves');
    expect(store.proposals({ status: 'approved' })[0]!.edited).toBe(true);
  });

  it('a rejection needs a comment and leaves the page alone', async () => {
    const p = await store.propose(prop());
    await expect(store.decide(p.id, 'reject', 'Paula')).rejects.toThrow(/comment/);
    await store.decide(p.id, 'reject', 'Paula', 'This is today\'s data, not a rule');
    expect(store.read('lessons/express.md')).toBeUndefined();
    await expect(store.decide(p.id, 'approve', 'Paula')).rejects.toThrow(/already rejected/);
  });

  it('flags proposals whose page changed in the meantime', async () => {
    await store.put('lessons/express.md', '# Express\nv1', 'Paula');
    const p = await store.propose(prop());
    await store.put('lessons/express.md', '# Express\nv2 by a person', 'Stefan');
    expect(store.proposals({ status: 'pending' })[0]!.baseChanged).toBe(true);
    await store.decide(p.id, 'approve', 'Paula');
    expect(store.proposals({ status: 'approved' })[0]!.baseChanged).toBe(true);
  });

  it('limits what an agent can queue and refuses no-op or reasonless proposals', async () => {
    await expect(store.propose(prop({ reason: 'short' }))).rejects.toThrow(/why/);
    await store.put('lessons/express.md', '# Express\nSame text.', 'Paula');
    await expect(store.propose(prop({ content: '# Express\nSame text.' }))).rejects.toThrow(/identical/);
    for (let i = 0; i < LIMITS.pendingPerAgent; i++) await store.propose(prop({ path: `lessons/p${i}.md` }));
    await expect(store.propose(prop({ path: 'lessons/one-more.md' }))).rejects.toThrow(/already/);
    await store.propose(prop({ path: 'lessons/other-agent.md', agent: 'sofa-max' }));
  });

  it('searches titles, paths and text', async () => {
    await store.put('suppliers/s-reiter.md', '# Maschinenbau Reiter\nSpare parts for CNC spindles, express possible.', 'Paula');
    await store.put('protocols/handoff.md', '# Handoff to procurement\nName the SKU and the date.', 'Paula');
    expect(store.search('spindle express')[0]!.path).toBe('suppliers/s-reiter.md');
    expect(store.search('handoff')[0]!.path).toBe('protocols/handoff.md');
    expect(store.search('nothing like this')).toEqual([]);
  });

  it('persists to disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-'));
    const a = new WikiStore(dir);
    await a.load();
    await a.put('index.md', '# Index', 'Paula');
    const b = new WikiStore(dir);
    await b.load();
    expect(b.read('index.md')?.updatedBy).toBe('Paula');
  });
});
