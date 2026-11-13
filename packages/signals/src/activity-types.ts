/**
 * Activity contracts of the Signals workflows (ADR-0037). Implementations live in `apps/agent-server/src/signals`.
 * Inputs and outputs stay small: observation bodies are capped (SIGNALS_LIMITS.maxBody).
 */
import type { ExpectationState, InterpretResult, ObservationBody, ObservationRecord, SignalAction, SignalState } from '@cw/shared';

export interface OpenExpectationSummary {
  id: string;
  title: string;
  description: string;
  matchHint: string;
  dueAt: string;
  state: SignalState;
}

export interface ObservationWorkflowInput {
  agentId: string;
  observation: ObservationBody & { receivedAt: string };
  /** Who handed it in (connector, agent, person). */
  by: string;
  /** Already interpreted (playground "commit" after a person reviewed and edited the result). */
  preInterpreted?: InterpretResult;
  /** Snapshot of the agent's Signals settings at the time the observation came in (keeps the workflow deterministic). */
  settings: { fulfilThreshold: number; defaultAction: SignalAction; graceDays: number };
}

export interface InterpretInput {
  observationId: string;
  observation: ObservationBody & { receivedAt: string };
  open: OpenExpectationSummary[];
}

export interface InterpretOutput extends InterpretResult {
  model?: string;
  costUsd?: number;
}

export interface ResolveExpectationInput {
  expectationId: string;
  reason: string;
  observationId: string;
  by: string;
}

export interface RaiseSignalResult {
  taskId?: string;
  notified?: number;
}

export interface SignalsActivities {
  /** Open and signalled expectations of this agent (visibility query). */
  listOpenExpectations(input: Record<string, never>): Promise<OpenExpectationSummary[]>;
  /** The model call: observation → events, fulfilments, new expectations. */
  interpretObservation(input: InterpretInput): Promise<InterpretOutput>;
  /** Runs the fulfil update on an expectation workflow; false if it was no longer open. */
  resolveExpectation(input: ResolveExpectationInput): Promise<boolean>;
  /** Appends the observation and what came of it to the agent's observation log. */
  recordObservation(input: ObservationRecord): Promise<void>;
  /** Overdue: notify people or start a follow-up task that needs plan approval. Waits while the agent is paused. */
  raiseSignal(input: { expectation: ExpectationState }): Promise<RaiseSignalResult>;
}

export const SIGNALS_ACTIVITY_ERRORS = {
  agentHalted: 'AgentHalted',
  aiNotConfigured: 'AiNotConfigured',
  invalidAnswer: 'InvalidModelAnswer',
} as const;
