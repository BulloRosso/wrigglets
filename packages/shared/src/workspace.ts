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
