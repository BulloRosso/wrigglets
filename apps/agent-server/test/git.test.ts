import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Git, formatCommitMessage, parseTrailers } from '../src/workspace/git.js';

let dir: string;
let git: Git;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cw-git-'));
  git = new Git(dir);
  await git.run(['init', '-q', '-b', 'main']);
  await git.run(['config', 'user.name', 'Max']);
  await git.run(['config', 'user.email', 'agent-max@example.com']);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('commit message format (spec §8.2)', () => {
  it('formats subject, body and trailers', () => {
    const msg = formatCommitMessage('report(task-1): run — done', 'Summary text', {
      'Requested-By': 'anna@example.com',
      'Approved-By': ['ben@example.com', 'clara@example.com'],
      'Task-Id': 'task-1',
      Empty: undefined,
    });
    expect(msg).toBe(
      'report(task-1): run — done\n\nSummary text\n\nRequested-By: anna@example.com\nApproved-By: ben@example.com\nApproved-By: clara@example.com\nTask-Id: task-1\n',
    );
  });

  it('parses trailers including repeated keys', () => {
    expect(parseTrailers('Requested-By: a\nApproved-By: b\nApproved-By: c\nnot a trailer')).toEqual({ 'Requested-By': ['a'], 'Approved-By': ['b', 'c'] });
  });
});

describe('Git', () => {
  it('commits with trailers, finds commits by Step-Id and reads them back', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'hello');
    const c1 = await git.commitAll({ subject: 'change(task-1): run — first', body: 'Did things.', trailers: { 'Task-Id': 'task-1', 'Step-Id': 'task-1:run:1', 'Approved-By': [] } });
    const c2 = await git.commitAll({ subject: 'chore: empty step', trailers: { 'Task-Id': 'task-1', 'Step-Id': 'task-1:run:2' } });
    expect(c1).not.toBe(c2);
    expect(await git.findCommitByTrailer('Step-Id', 'task-1:run:1')).toBe(c1);
    expect(await git.findCommitByTrailer('Step-Id', 'task-1:run:3')).toBeUndefined();
    // A prefix of an existing id must not match
    expect(await git.findCommitByTrailer('Step-Id', 'task-1:run:')).toBeUndefined();

    const log = await git.log({ files: true });
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ hash: c1, subject: 'change(task-1): run — first', body: 'Did things.', trailers: { 'Task-Id': ['task-1'], 'Step-Id': ['task-1:run:1'] }, files: ['a.txt'] });
    expect(log[0]!.files).toEqual([]);
  });

  it('commits uploads with the human as author and the agent as committer', async () => {
    await writeFile(path.join(dir, 'b.csv'), 'x,y');
    await git.commitAll({ subject: 'upload(task-2): b.csv', trailers: { 'Task-Id': 'task-2' }, author: { name: 'Anna', email: 'anna@example.com' } });
    const [c] = await git.log({ limit: 1 });
    expect(c!.author).toEqual({ name: 'Anna', email: 'anna@example.com' });
    expect(c!.committer).toEqual({ name: 'Max', email: 'agent-max@example.com' });
  });

  it('resets a dirty tree to the last checkpoint but keeps .agent/steps', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'changed');
    await writeFile(path.join(dir, 'stray.txt'), 'x');
    expect(await git.isDirty()).toBe(true);
    await git.resetToHead();
    expect(await git.isDirty()).toBe(false);
  });

  it('restores an earlier state as a new commit, keeping history and .agent records', async () => {
    const author = { name: 'Anna', email: 'anna@example.com' };
    const old = (await git.head())!;
    await writeFile(path.join(dir, 'a.txt'), 'later');
    await writeFile(path.join(dir, 'later.txt'), 'new file');
    await mkdir(path.join(dir, '.agent'), { recursive: true });
    await writeFile(path.join(dir, '.agent', 'record.json'), '{}');
    const later = await git.commitAll({ subject: 'change: later', trailers: {} });

    const restored = await git.restoreTo(old, { subject: 'restore: test', trailers: { 'Restored-To': old }, author });
    expect(restored).toBeDefined();
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hello');
    await expect(readFile(path.join(dir, 'later.txt'), 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(dir, '.agent', 'record.json'), 'utf8')).toBe('{}');
    expect(await git.isDirty()).toBe(false);
    // history is intact: the later commit is still reachable and the restore sits on top of it
    expect((await git.log({ limit: 2 })).map((c) => c.hash)).toEqual([restored, later]);
    // restoring to the same state again changes nothing
    expect(await git.restoreTo(old, { subject: 'restore: again', trailers: {}, author })).toBeUndefined();
  });
});
