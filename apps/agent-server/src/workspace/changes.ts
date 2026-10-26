import type { CommitInfo, WorkspaceChange } from '@cw/shared';

export const isRestorePointCommit = (c: CommitInfo) =>
  !!(c.trailers['Audit-Export'] || c.trailers['Restored-To'] || c.subject === 'chore: initialize workspace');

export interface TaskMeta {
  title?: string;
  status?: string;
  requestedBy?: string;
  requestedByName?: string;
}

/** email/UPN → display name, from task metadata and commit authors (uploads, manual edits). */
export function collectNames(commits: CommitInfo[], tasks: Map<string, TaskMeta>): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of commits) if (c.author.name && c.author.name !== c.author.email) names.set(c.author.email.toLowerCase(), c.author.name);
  for (const m of tasks.values()) if (m.requestedBy && m.requestedByName) names.set(m.requestedBy.toLowerCase(), m.requestedByName);
  return names;
}

/**
 * Folds the commit log (newest first) into one entry per task, so that users see what happened instead of
 * the several technical commits each task produces.
 * @param finalizeByTask the finalize commit of each task (from the unfiltered log): the state after the task
 */
export function groupChanges(commits: CommitInfo[], tasks: Map<string, TaskMeta>, finalizeByTask: Map<string, string>, names: Map<string, string> = new Map(), limit = 50): WorkspaceChange[] {
  const out = new Map<string, WorkspaceChange>();
  for (const c of commits) {
    const taskId = c.trailers['Task-Id']?.[0];
    const key = taskId ?? c.hash;
    let ch = out.get(key);
    if (!ch) {
      const kind: WorkspaceChange['kind'] = taskId ? 'task' : c.trailers['Restored-To'] ? 'restore' : c.subject === 'chore: initialize workspace' ? 'start' : 'edit';
      const meta = taskId ? tasks.get(taskId) : undefined;
      ch = {
        id: key,
        kind,
        title:
          kind === 'task'
            ? (meta?.title ?? c.subject.replace(/^[^:]*:\s*/, ''))
            : kind === 'restore'
              ? 'Workspace set back to an earlier state'
              : kind === 'start'
                ? 'Workspace created'
                : c.subject.replace(/^[^:]*:\s*/, ''),
        at: c.date,
        taskId,
        requestedBy: c.trailers['Requested-By']?.[0],
        approvedBy: [],
        status: meta?.status,
        files: [],
        restoreHash: taskId ? finalizeByTask.get(taskId) : isRestorePointCommit(c) ? c.hash : undefined,
        commits: [],
      };
      out.set(key, ch);
    }
    ch.requestedBy ??= c.trailers['Requested-By']?.[0];
    for (const a of c.trailers['Approved-By'] ?? []) if (a && !ch.approvedBy.includes(a)) ch.approvedBy.push(a);
    for (const f of c.files ?? []) if (!f.startsWith('.agent/') && !ch.files.includes(f)) ch.files.push(f);
    ch.commits.push({ hash: c.hash, shortHash: c.shortHash, subject: c.subject });
  }
  const display = (upn: string) => names.get(upn.toLowerCase()) ?? upn;
  // Entries that did not touch any file are of no interest to users (the start of the workspace is kept as anchor).
  return [...out.values()]
    .filter((ch) => ch.files.length > 0 || ch.kind === 'start')
    .slice(0, limit)
    .map((ch) => ({ ...ch, requestedBy: ch.requestedBy && display(ch.requestedBy), approvedBy: ch.approvedBy.map(display) }));
}
