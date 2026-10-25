import { z } from 'zod';

/*
 * Agent kill switch (ADR-0022). Levels are ordered; the effective level of an agent is the
 * maximum of the global level and its own level.
 *   tools_off – the MCP gateway hides and rejects all tools (incl. A2A)
 *   paused    – additionally no new steps; a running step is aborted and re-queued; tasks wait
 *   stopped   – additionally all running tasks are cancelled and the container is stopped
 */

export const KILL_LEVELS = ['normal', 'tools_off', 'paused', 'stopped'] as const;
export type KillLevel = (typeof KILL_LEVELS)[number];

export const KILL_LEVEL_LABEL: Record<KillLevel, string> = {
  normal: 'Normal',
  tools_off: 'Tools off',
  paused: 'Paused',
  stopped: 'Stopped',
};

export const killRank = (l: KillLevel) => KILL_LEVELS.indexOf(l);
export const maxLevel = (...levels: KillLevel[]): KillLevel => levels.reduce((a, b) => (killRank(b) > killRank(a) ? b : a), 'normal');
export const atLeast = (level: KillLevel, min: KillLevel) => killRank(level) >= killRank(min);

export interface KillSwitchEntry {
  level: KillLevel;
  reason?: string;
  by: string;
  at: string;
  /** Set when a safety rule tripped the switch. */
  auto?: { rule: string; detail?: string };
}

export interface KillSwitchState {
  global: KillSwitchEntry;
  agents: Record<string, KillSwitchEntry>;
}

export interface EffectiveKillSwitch {
  level: KillLevel;
  source: 'global' | 'agent' | 'none';
  entry?: KillSwitchEntry;
}

export function effectiveKillSwitch(state: KillSwitchState, agentId: string): EffectiveKillSwitch {
  const g = state.global;
  const a = state.agents[agentId];
  if (!a && g.level === 'normal') return { level: 'normal', source: 'none' };
  if (a && killRank(a.level) > killRank(g.level)) return { level: a.level, source: 'agent', entry: a };
  if (g.level !== 'normal') return { level: g.level, source: 'global', entry: g };
  return { level: a?.level ?? 'normal', source: a ? 'agent' : 'none', entry: a };
}

export const setKillSwitchBody = z
  .object({ level: z.enum(KILL_LEVELS), reason: z.string().trim().max(500).optional() })
  .refine((b) => b.level === 'normal' || !!b.reason, { message: 'A reason is required', path: ['reason'] });
export type SetKillSwitchBody = z.infer<typeof setKillSwitchBody>;

/* ------------------------------------------------------------------ safety rules */

export const SAFETY_RULE_KINDS = ['permission_violation', 'tokens_per_hour', 'tool_denials', 'tool_rate', 'failed_streak'] as const;
export type SafetyRuleKind = (typeof SAFETY_RULE_KINDS)[number];

export const safetyRule = z.object({
  id: z.string().min(1).max(60),
  kind: z.enum(SAFETY_RULE_KINDS),
  enabled: z.boolean(),
  /** Threshold; meaning depends on kind (count, tokens, calls per minute). */
  threshold: z.number().int().min(1),
  /** Observation window in minutes (where applicable). */
  windowMinutes: z.number().int().min(1).max(24 * 60).default(60),
  level: z.enum(KILL_LEVELS).refine((l) => l !== 'normal', 'level must not be normal'),
});
export type SafetyRule = z.infer<typeof safetyRule>;
export const safetyRules = z.array(safetyRule).max(50);

export const DEFAULT_SAFETY_RULES: SafetyRule[] = [
  { id: 'permission-violation', kind: 'permission_violation', enabled: true, threshold: 1, windowMinutes: 60, level: 'paused' },
  { id: 'token-spike', kind: 'tokens_per_hour', enabled: true, threshold: 2_000_000, windowMinutes: 60, level: 'paused' },
  { id: 'tool-denials', kind: 'tool_denials', enabled: true, threshold: 20, windowMinutes: 10, level: 'tools_off' },
  { id: 'tool-rate', kind: 'tool_rate', enabled: true, threshold: 120, windowMinutes: 1, level: 'tools_off' },
  { id: 'failed-streak', kind: 'failed_streak', enabled: true, threshold: 5, windowMinutes: 24 * 60, level: 'paused' },
];

/** Counters an agent reports for rule evaluation (`GET /internal/stats`). */
export interface AgentSafetyStats {
  at: string;
  tokensLastHour: number;
  permissionViolations: number;
  stepFailuresLastHour: number;
}

/** Counters the MCP gateway reports per agent. */
export interface GatewayAgentStats {
  callsLastMinute: number;
  callsLastHour: number;
  deniedOrFailedLast10Min: number;
}
