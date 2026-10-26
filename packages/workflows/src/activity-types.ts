/**
 * Activity contracts. Workflows import these as types only; the implementations live in
 * `apps/agent-server/src/activities`. Inputs and outputs MUST stay small (< 50 KB):
 * large content goes to the artifacts directory and is referenced by relative path.
 */
import type { DelegationStatus, Identity, SecurityWarning, StagingFile, StepKind, TaskState, TaskStatus, TaskType } from '@cw/shared';

/** Values written as Git trailers. Task-Id, Workflow-Id, Run-Id and Step-Id are added by the activity. */
export interface CommitMeta {
  requestedBy: string;
  approvedBy: string[];
  trigger: string;
}

export interface RunAgentStepInput {
  taskId: string;
  stepId: string;
  kind: StepKind;
  taskType: TaskType;
  /** Short label (also used as the activity summary in the Temporal UI and the timeline). */
  summary: string;
  prompt: string;
  sessionId?: string;
  budgetRemaining: number;
  /** The human the work is done for (forwarded as "on behalf of" when the step delegates via A2A). */
  requestedBy?: Identity;
  /** Used to rebuild context if the harness session was lost (spec §6.5). */
  context: { title: string; instructions: string; planPath?: string; previousSummaries: string[] };
  meta: CommitMeta;
}

export interface RunAgentStepResult {
  sessionId: string;
  summary: string;
  commit: string;
  tokens: number;
  tokenDetail: { input: number; output: number; reasoning: number; cacheRead: number };
  cost?: number;
  artifacts: string[];
  filesTouched: string[];
  startedAt: string;
  endedAt: string;
  /** True if the step had already been committed before (idempotent replay after a crash). */
  reused: boolean;
  /** Tasks delegated to other agents during this step (from a2a__send_task tool results). */
  delegations?: Array<{ agentId: string; taskId: string }>;
}

/** Details attached to the non-retryable `BudgetExceeded` failure. */
export interface BudgetExceededDetails {
  commit: string;
  tokens: number;
  summary: string;
}

export interface VerifyInput {
  taskId: string;
  type: TaskType;
  round: number;
  stepIds: string[];
  summary: string;
}

export interface VerifyResult {
  ok: boolean;
  reportPath: string;
  failures: string[];
  anomalies: string[];
}

export interface ApplyUploadInput {
  taskId: string;
  files: StagingFile[];
  requestedBy: Identity;
  meta: CommitMeta;
  summary: string;
}

export interface ApplyUploadResult {
  commit: string;
  paths: string[];
}

export interface FinalizeTaskInput {
  taskId: string;
  outcome: TaskStatus;
  state: TaskState;
  meta: CommitMeta;
  /** Revert this task's commits (used when a deviation is rejected). */
  revert?: boolean;
  summary: string;
}

export interface FinalizeTaskResult {
  finalCommit: string;
  auditPath: string;
  reverted: string[];
  revertError?: string;
}

export type NotificationKind =
  | 'approval_requested'
  | 'approval_reminder'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'budget_exceeded';

export interface NotifyInput {
  to: Identity[];
  kind: NotificationKind;
  taskId: string;
  title: string;
  text?: string;
}

export interface MaintenanceResult {
  kind: string;
  details: Record<string, unknown>;
}

export interface CheckDelegationsInput {
  delegations: Array<{ agentId: string; taskId: string }>;
}

export interface AgentActivities {
  checkDelegations(input: CheckDelegationsInput): Promise<DelegationStatus[]>;
  runAgentStep(input: RunAgentStepInput): Promise<RunAgentStepResult>;
  verify(input: VerifyInput): Promise<VerifyResult>;
  applyUpload(input: ApplyUploadInput): Promise<ApplyUploadResult>;
  finalizeTask(input: FinalizeTaskInput): Promise<FinalizeTaskResult>;
  notify(input: NotifyInput): Promise<void>;
  gitMaintenance(input: { summary: string }): Promise<MaintenanceResult>;
  backupWorkspace(input: { date: string; summary: string }): Promise<MaintenanceResult>;
  cleanupArtifacts(input: { olderThanDays: number; summary: string }): Promise<MaintenanceResult>;
  /** Delivers a security warning to the control plane (admin dashboard); retried until it arrives. */
  reportSecurityAlert(input: SecurityWarning): Promise<void>;
}

export interface AgentLocalActivities {
  isWorkflowRunning(input: { workflowId: string }): Promise<boolean>;
}

export const ACTIVITY_ERRORS = {
  budgetExceeded: 'BudgetExceeded',
  permissionDenied: 'PermissionDenied',
  harnessConfig: 'HarnessConfigError',
  harnessUnavailable: 'HarnessUnavailable',
  provider: 'ProviderError',
  aiNotConfigured: 'AiNotConfigured',
  guardInactive: 'GuardInactive',
} as const;
