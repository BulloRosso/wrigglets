export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  modified?: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  date: string;
  subject: string;
  body: string;
  trailers: Record<string, string[]>;
  files?: string[];
}

/** A state of the workspace the user can go back to (the end of a task, or the start). Never exposes Git details. */
export interface RestorePoint {
  hash: string;
  date: string;
  kind: 'start' | 'task' | 'restore';
  /** Task title (kind 'task'), or a fixed text for the other kinds. */
  label: string;
  taskId?: string;
  outcome?: string;
  /** The workspace currently equals this state. */
  current: boolean;
}

/** One entry of the workspace history for business users: a task (or other change) instead of raw commits. */
export interface WorkspaceChange {
  id: string;
  kind: 'task' | 'restore' | 'edit' | 'start';
  title: string;
  /** Newest activity of this change. */
  at: string;
  taskId?: string;
  requestedBy?: string;
  approvedBy: string[];
  /** Task status (e.g. completed, failed, running); absent for non-task changes. */
  status?: string;
  /** Files the change touched, platform records (`.agent/`) left out. */
  files: string[];
  /** Set when the workspace can be reset to the state right after this change. */
  restoreHash?: string;
  /** The workspace currently equals the state after this change. */
  current?: boolean;
  /** Technical details, shown only on request. */
  commits: Array<{ hash: string; shortHash: string; subject: string }>;
}

export interface NotificationDto {
  id: string;
  at: string;
  to: string;
  kind: string;
  taskId: string;
  title?: string;
  text?: string;
}

export interface AuditSearchResult {
  tasks: Array<{
    taskId: string;
    title: string;
    status: string;
    requestedBy: string;
    approvedBy: string[];
    startTime?: string;
    source: 'visibility' | 'audit-export';
    match?: string;
  }>;
  commits: CommitInfo[];
}
