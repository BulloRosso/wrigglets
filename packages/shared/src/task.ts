import { z } from 'zod';
import type { Identity, Principal } from './identity.js';

export const TASK_TYPES = ['analysis', 'change', 'report', 'upload'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const APPROVAL_POLICIES = ['plan', 'none', 'deviation'] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const ACTIVE_STATUSES = [
  'queued',
  'planning',
  'awaiting_approval',
  'running',
  'verifying',
  'fixing',
  'finalizing',
  'suspended',
  'awaiting_delegations',
] as const;
export const TERMINAL_STATUSES = [
  'completed',
  'rejected',
  'cancelled',
  'failed',
  'budget_exceeded',
  'expired',
] as const;
export type TaskStatus = (typeof ACTIVE_STATUSES)[number] | (typeof TERMINAL_STATUSES)[number];

export const isTerminalStatus = (s: TaskStatus) => (TERMINAL_STATUSES as readonly string[]).includes(s);

export type TaskTrigger =
  | { kind: 'user' }
  | { kind: 'schedule'; scheduleId: string; owner: Identity }
  /** Delegated by another agent via A2A (ADR-0023); requestedBy = the human behind the calling task. */
  | { kind: 'agent'; callerAgentId: string; callerTaskId?: string; a2aTaskId: string };

/** Who may decide on an approval request. */
export type ApproverPolicy = 'approver-or-requester' | 'approver-only' | 'requester-only';

/** Values that come from server configuration but must be deterministic inside the workflow. */
export interface TaskSettings {
  maxFixRounds: number;
  approvalReminderAfter: string;
  approvalExpireAfter: string;
  approverPolicy: ApproverPolicy;
  maxRevisions: number;
}

export interface StagingFile {
  /** Path relative to STAGING_DIR. */
  stagingPath: string;
  /** Target path relative to the workspace root. */
  targetPath: string;
  size: number;
}

export interface TaskInput {
  /** Informational only. The workflow always uses its own workflow id as task id. */
  taskId?: string;
  agentId: string;
  title: string;
  instructions: string;
  type: TaskType;
  requestedBy: Identity;
  trigger: TaskTrigger;
  approval: ApprovalPolicy;
  budget: { maxTokens: number };
  settings: TaskSettings;
  attachments?: StagingFile[];
}

export type StepKind = 'plan' | 'run' | 'fix';

export interface StepRecord {
  stepId: string;
  kind: StepKind;
  summary: string;
  commit: string;
  startedAt: string;
  endedAt: string;
  tokens: number;
  artifacts: string[];
  filesTouched: string[];
}

export interface Note {
  by: Identity;
  text: string;
  at: string;
}

export interface TaskState {
  taskId: string;
  agentId: string;
  title: string;
  instructions: string;
  type: TaskType;
  approval: ApprovalPolicy;
  status: TaskStatus;
  lock: 'none' | 'waiting' | 'held';
  requestedBy: Identity;
  trigger: TaskTrigger;
  createdAt: string;
  sessionId?: string;
  awaiting?: 'plan' | 'deviation';
  plan?: { path: string; summary: string; commit: string };
  approvedPlan?: { path: string; decidedBy: Identity; comment?: string; at: string };
  approvedBy: string[];
  decisions: Array<{ decision: Decision; by: Identity; comment?: string; at: string; kind: 'plan' | 'deviation' }>;
  revisions: number;
  steps: StepRecord[];
  verify?: { ok: boolean; reportPath: string; anomalies?: string[]; round: number };
  usage: { tokens: number; maxTokens: number; cost?: number };
  notes: Note[];
  result?: { summary: string; outputs: string[]; finalCommit: string; auditPath?: string };
  error?: string;
  cancelRequested?: { by: Identity; reason?: string; at: string };
  /** Tasks delegated to other agents via A2A, with their latest known status. */
  delegations?: Array<{ agentId: string; taskId: string; state: string; terminal: boolean; summary?: string; at: string }>;
  /** Set while the agent is paused by the kill switch and this task waits to resume. */
  suspended?: { reason?: string; at: string };
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  summary?: string;
  finalCommit?: string;
  auditPath?: string;
  error?: string;
}

export type Decision = 'approve' | 'reject' | 'revise';

export interface DecisionInput {
  decision: Decision;
  comment?: string;
  by: Principal;
}
export interface CancelInput {
  by: Principal;
  reason?: string;
}
export interface CommentInput {
  by: Principal;
  text: string;
}

/* ---------------------------------------------------------------- API DTOs (zod) */

export const createTaskBody = z.object({
  title: z.string().trim().min(3).max(120),
  instructions: z.string().trim().min(1).max(20_000),
  type: z.enum(['analysis', 'change', 'report']),
  approval: z.enum(APPROVAL_POLICIES).default('plan'),
  maxTokens: z.number().int().min(1_000).max(5_000_000).optional(),
});
export type CreateTaskBody = z.infer<typeof createTaskBody>;

export const decisionBody = z
  .object({
    decision: z.enum(['approve', 'reject', 'revise']),
    comment: z.string().trim().max(4_000).optional(),
  })
  .refine((b) => b.decision === 'approve' || !!b.comment, {
    message: 'A comment is required to reject or request changes',
    path: ['comment'],
  });
export type DecisionBody = z.infer<typeof decisionBody>;

export const cancelBody = z.object({ reason: z.string().trim().max(2_000).optional() });
export const commentBody = z.object({ text: z.string().trim().min(1).max(4_000) });

export const listTasksQuery = z.object({
  status: z.string().optional(),
  requestedBy: z.string().optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  pageToken: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface TaskListItem {
  taskId: string;
  runId?: string;
  title: string;
  type: TaskType | 'maintenance';
  status: TaskStatus | string;
  requestedBy: string;
  trigger: string;
  scheduleId?: string;
  approvedBy: string[];
  startTime: string;
  closeTime?: string;
  workflowStatus: string;
}

export interface TaskDetail {
  state: TaskState;
  workflow: {
    runId: string;
    status: string;
    startTime: string;
    closeTime?: string;
    historyLength?: number;
  };
  source: 'live' | 'audit-export';
}
