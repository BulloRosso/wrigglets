import { describe, expect, it } from 'vitest';
import type { CommitInfo } from '@cw/shared';
import { groupChanges } from '../src/workspace/changes.js';

const commit = (hash: string, subject: string, trailers: Record<string, string[]>, files: string[] = []): CommitInfo => ({
  hash,
  shortHash: hash.slice(0, 7),
  author: { name: 'a', email: 'a@x' },
  committer: { name: 'a', email: 'a@x' },
  date: '2026-10-26T10:00:00Z',
  subject,
  body: '',
  trailers,
  files,
});

describe('groupChanges', () => {
  it('folds the commits of a task into one entry, hides .agent files and offers the finalize state', () => {
    const log = [
      commit('f1', 'chore(t1): finalize — completed', { 'Task-Id': ['t1'], 'Audit-Export': ['t1'] }, ['.agent/audit/t1.json']),
      commit('r1', 'report(t1): run — done', { 'Task-Id': ['t1'], 'Requested-By': ['anna@x'], 'Approved-By': ['ben@x'] }, ['.agent/steps/t1.json', 'reports/news.md']),
      commit('s0', 'chore: initialize workspace', {}),
    ];
    const noFiles = [commit('f2', 'chore(t2): finalize — failed', { 'Task-Id': ['t2'], 'Audit-Export': ['t2'] }, ['.agent/audit/t2.json'])];
    const names = new Map([['anna@x', 'Anna Berger'], ['ben@x', 'Ben Koch']]);
    const out = groupChanges([...noFiles, ...log], new Map([['t1', { title: 'Anthropic news', status: 'completed' }]]), new Map([['t1', 'f1']]), names);
    expect(out).toHaveLength(2); // t2 touched no file
    expect(out[0]).toMatchObject({ kind: 'task', title: 'Anthropic news', status: 'completed', requestedBy: 'Anna Berger', approvedBy: ['Ben Koch'], files: ['reports/news.md'], restoreHash: 'f1' });
    expect(out[0]!.commits.map((c) => c.hash)).toEqual(['f1', 'r1']);
    expect(out[1]).toMatchObject({ kind: 'start', title: 'Workspace created', restoreHash: 's0' });
  });
});
