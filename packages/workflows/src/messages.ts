import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';
import type {
  AgentStatus,
  CancelInput,
  CommentInput,
  DecisionInput,
  Identity,
  KillLevel,
  TaskState,
} from '@cw/shared';

/* ------------------------------------------------------- AgentWorkflow (lock manager) */

export interface LockRequest {
  taskId: string;
  /**
   * cleanup: audit finalization, granted even while the agent is paused/stopped.
   * resume:  re-acquire after a suspension, queued at the front.
   */
  purpose?: 'cleanup' | 'resume';
}

/** Ask for the workspace lock. Idempotent. */
export const acquireSignal = defineSignal<[LockRequest]>('acquire');
/** Give the workspace lock back (or leave the queue). Idempotent. */
export const releaseSignal = defineSignal<[LockRequest]>('release');
/** Admin-only (enforced by the API). Clears the current holder. */
export const forceReleaseSignal = defineSignal<[{ taskId: string; by: Identity }]>('forceRelease');
export const agentStatusQuery = defineQuery<AgentStatus>('status');
/** Control plane → lock manager: effective kill-switch level of this agent (ADR-0022). */
export const setKillSwitchSignal = defineSignal<[{ level: KillLevel; reason?: string; by: string; at: string }]>('setKillSwitch');

/* ------------------------------------------------------- Lock holders (task / maintenance) */

/** Sent by the AgentWorkflow to the workflow that now holds the workspace lock. */
export const grantedSignal = defineSignal<[LockRequest]>('granted');
/** Sent by the AgentWorkflow to the current holder when the agent is paused: abort the step, re-queue. */
export const suspendSignal = defineSignal<[{ taskId: string; reason?: string }]>('suspend');

/* ------------------------------------------------------- TaskWorkflow */

export const decideUpdate = defineUpdate<TaskState, [DecisionInput]>('decide');
export const cancelUpdate = defineUpdate<TaskState, [CancelInput]>('cancel');
export const commentUpdate = defineUpdate<TaskState, [CommentInput]>('comment');
export const taskStateQuery = defineQuery<TaskState>('state');
