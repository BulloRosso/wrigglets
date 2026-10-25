import { z } from 'zod';
import type { Identity } from './identity.js';

/**
 * Chat with the agent about a task (ADR-0030): questions are answered by the agent's model with the task as
 * context (request, plan, step reports, result files and images). Read-only — work still happens in steps.
 */
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
}

export const taskChatBody = z.object({ text: z.string().trim().min(1).max(8000) });
export type TaskChatBody = z.infer<typeof taskChatBody>;
