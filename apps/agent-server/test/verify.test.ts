import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Git } from '../src/workspace/git.js';
import { createVerify } from '../src/activities/verify.js';
import type { ActivityDeps } from '../src/activities/deps.js';

let dir: string;
let artifacts: string;
let git: Git;

const commit = (taskId: string, subject: string) => git.commitAll({ subject, trailers: { 'Task-Id': taskId } });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cw-verify-'));
  artifacts = await mkdtemp(path.join(tmpdir(), 'cw-verify-art-'));
  git = new Git(dir);
  await git.run(['init', '-q', '-b', 'main']);
  await git.run(['config', 'user.name', 'Lara']);
  await git.run(['config', 'user.email', 'agent-lara@example.com']);
  await writeFile(path.join(dir, 'existing.md'), 'team data');
  await git.commitAll({ subject: 'init', trailers: {} });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(artifacts, { recursive: true, force: true });
});

const verify = () => createVerify({ config: { workspaceDir: dir, artifactsDir: artifacts }, git } as unknown as ActivityDeps);

describe('verification path policy (net effect of the task)', () => {
  it('accepts a report that was first written to the wrong place and then moved to reports/', async () => {
    await writeFile(path.join(dir, 'aktienkurs-nvidia.md'), '# NVIDIA');
    await commit('t1', 'run');
    await mkdir(path.join(dir, 'reports'), { recursive: true });
    await rename(path.join(dir, 'aktienkurs-nvidia.md'), path.join(dir, 'reports', 'aktienkurs-nvidia.md'));
    await commit('t1', 'fix');
    const r = await verify()({ taskId: 't1', type: 'report', round: 2, stepIds: [], summary: '' });
    expect(r.ok).toBe(true);
  });

  it('still rejects changing or deleting files outside reports/ that existed before the task', async () => {
    await unlink(path.join(dir, 'existing.md'));
    await commit('t2', 'run');
    const r = await verify()({ taskId: 't2', type: 'report', round: 1, stepIds: [], summary: '' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('existing.md');
  });
});
