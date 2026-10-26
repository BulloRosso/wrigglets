import { z } from 'zod';
import type { Identity } from './identity.js';
import type { CreateScheduleBody } from './schedule.js';

/**
 * Chat with the agent about a task (ADR-0030): questions are answered by the agent's model with the task as
 * context (request, plan, step reports, result files and images). Read-only — work still happens in steps.
 */
export interface ScheduleProposal {
  /** What would be created — exactly what the person sees on the card and what is created on approval. */
  schedule: CreateScheduleBody;
  status: 'pending' | 'approved' | 'rejected';
  /** The person whose question led to the proposal; only they (or an admin) may decide, and they become the schedule's owner. */
  requestedBy: Identity;
  decidedBy?: Identity;
  decidedAt?: string;
  /** Set once approved. */
  scheduleId?: string;
}

export const scheduleProposalDecisionBody = z.object({ decision: z.enum(['approve', 'reject']) });
export type ScheduleProposalDecisionBody = z.infer<typeof scheduleProposalDecisionBody>;

export interface TaskChatMessage {
  id: string;
  at: string;
  role: 'user' | 'agent';
  /** Author of a user message. */
  by?: Identity;
  /** Markdown. */
  text: string;
  model?: string;
  tokens?: number;
  costUsd?: number;
  /** Files given to the model as context for this answer. */
  context?: string[];
  error?: boolean;
  /** The agent proposes a recurring task. Nothing is scheduled until a person approves it (ADR-0034). */
  proposal?: ScheduleProposal;
}

export const taskChatBody = z.object({ text: z.string().trim().min(1).max(8000) });
export type TaskChatBody = z.infer<typeof taskChatBody>;
