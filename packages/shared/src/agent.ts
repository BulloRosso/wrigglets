import type { Identity } from './identity.js';
import type { SecurityWarning } from './guard.js';
import type { KillLevel } from './killswitch.js';

export interface LockHolder {
  taskId: string;
  since: string;
  purpose?: 'cleanup' | 'resume';
}

export interface AgentState {
  agentId: string;
  holder?: LockHolder;
  waiting: Array<{ taskId: string; requestedAt: string; purpose?: 'cleanup' | 'resume' }>;
  stats: { grantsTotal: number; forcedReleases: number; suspensions?: number };
  lastForceRelease?: { taskId: string; by: Identity; at: string };
  /** Effective kill-switch level of this agent (set by the control plane, ADR-0022). */
  killSwitch?: { level: KillLevel; reason?: string; by: string; at: string };
  /** Warnings of the exfiltration guard received by this workflow (most recent last, ADR-0033). */
  securityWarnings?: SecurityWarning[];
}

export type AgentStatus = Pick<AgentState, 'holder' | 'waiting' | 'stats' | 'killSwitch' | 'securityWarnings'>;

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  agentId: string;
  displayName: string;
  harness: { state: 'starting' | 'up' | 'down'; version?: string; downSince?: string; restarts: number };
  temporal: { state: 'up' | 'down'; namespace: string; checkedAt?: string; error?: string };
}

export interface AgentStatusResponse {
  agentId: string;
  displayName: string;
  holder?: LockHolder & { title?: string };
  waiting: Array<{ taskId: string; requestedAt: string; title?: string }>;
  stats: { grantsTotal: number };
  killSwitch?: AgentState['killSwitch'];
  health: HealthReport;
  /** USD spend of the last 30 days vs. limit, and whether a real AI model is configured (ADR-0029). */
  spend?: import('./ai.js').AgentSpend;
}
