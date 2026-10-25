import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_SAFETY_RULES,
  atLeast,
  safetyRules,
  type AgentSafetyStats,
  type GatewayAgentStats,
  type SafetyRule,
} from '@cw/shared';
import { q } from '@cw/shared/search-attributes';
import type { GatewayConfigService } from './gateway.js';
import type { KillSwitchService } from './killswitch.js';
import { logger } from './logger.js';
import type { AgentRegistry } from './registry.js';
import type { AgentRuntime } from './runtime/types.js';
import type { TemporalPlatform } from './temporal/platform.js';

export interface RuleObservation {
  agentId: string;
  ruleId: string;
  value: number;
  threshold: number;
  tripped: boolean;
}

/** Pure rule evaluation (unit-tested). */
export function evaluate(rule: SafetyRule, s: { agent?: AgentSafetyStats; gateway?: GatewayAgentStats; failedStreak?: number }): number | undefined {
  switch (rule.kind) {
    case 'permission_violation':
      return s.agent?.permissionViolations;
    case 'tokens_per_hour':
      return s.agent?.tokensLastHour;
    case 'tool_denials':
      return s.gateway?.deniedOrFailedLast10Min;
    case 'tool_rate':
      return s.gateway?.callsLastMinute;
    case 'failed_streak':
      return s.failedStreak;
  }
}

/**
 * Automatic kill-switch triggers (ADR-0022). Evaluated every 30 s; a tripped rule raises the agent's
 * level (never lowers it) and is recorded as `auto` with the rule id. Reset is always manual.
 */
export class SafetyRuleEngine {
  private rules: SafetyRule[] = DEFAULT_SAFETY_RULES;
  private readonly file: string;
  last: RuleObservation[] = [];
  lastRun?: string;
  /** After a manual reset, rules do not re-trip immediately for this agent. */
  private readonly snoozedUntil = new Map<string, number>();

  constructor(
    dataDir: string,
    private readonly registry: AgentRegistry,
    private readonly runtime: AgentRuntime,
    private readonly temporal: TemporalPlatform,
    private readonly gateway: GatewayConfigService,
    private readonly killSwitch: KillSwitchService,
  ) {
    this.file = path.join(dataDir, 'admin', 'safety-rules.json');
  }

  async load() {
    try {
      this.rules = safetyRules.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      await this.save(DEFAULT_SAFETY_RULES);
    }
  }

  snooze(agentId: string, minutes = 60) {
    this.snoozedUntil.set(agentId, Date.now() + minutes * 60_000);
  }

  get(): SafetyRule[] {
    return this.rules;
  }

  async save(rules: SafetyRule[]) {
    this.rules = safetyRules.parse(rules);
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.rules, null, 2));
  }

  start(intervalMs = 30_000) {
    setInterval(() => void this.run().catch((err) => logger.warn({ err: String(err) }, 'safety rule evaluation failed')), intervalMs).unref();
  }

  async run(): Promise<RuleObservation[]> {
    const gatewayStats = (await this.gateway.gatewayCall<Record<string, GatewayAgentStats>>('/internal/stats')) ?? {};
    const obs: RuleObservation[] = [];
    for (const spec of this.registry.list()) {
      const agentId = spec.agentId;
      const agent = await this.agentStats(agentId);
      const failedStreak = this.rules.some((r) => r.enabled && r.kind === 'failed_streak') ? await this.failedStreak(agentId) : undefined;
      for (const rule of this.rules.filter((r) => r.enabled)) {
        const value = evaluate(rule, { agent, gateway: gatewayStats[agentId], failedStreak });
        if (value === undefined) continue;
        const tripped = value >= rule.threshold;
        obs.push({ agentId, ruleId: rule.id, value, threshold: rule.threshold, tripped });
        const snoozed = (this.snoozedUntil.get(agentId) ?? 0) > Date.now();
        if (tripped && !snoozed && !atLeast(this.killSwitch.effective(agentId).level, rule.level)) {
          logger.warn({ agentId, rule: rule.id, value, threshold: rule.threshold, level: rule.level }, 'safety rule tripped');
          await this.killSwitch.setAgent(agentId, rule.level, `Safety rule "${rule.id}": ${value} ≥ ${rule.threshold}`, 'safety-rules', {
            rule: rule.id,
            detail: `${value} ≥ ${rule.threshold}`,
          });
        }
      }
    }
    this.last = obs;
    this.lastRun = new Date().toISOString();
    return obs;
  }

  private async agentStats(agentId: string): Promise<AgentSafetyStats | undefined> {
    const entry = this.registry.get(agentId);
    if (!entry) return undefined;
    try {
      const res = await fetch(`${this.runtime.internalUrl(agentId)}/internal/stats`, {
        headers: { authorization: `Bearer ${entry.secrets.internalToken}` },
        signal: AbortSignal.timeout(2500),
      });
      return res.ok ? ((await res.json()) as AgentSafetyStats) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Number of most recent closed tasks that failed in a row. */
  private async failedStreak(agentId: string): Promise<number> {
    const tasks = await this.temporal.tasks(`AgentId = ${q(agentId)} AND WorkflowType = 'taskWorkflow' AND ExecutionStatus != 'Running'`, 20);
    let n = 0;
    for (const t of tasks) {
      if (['failed', 'budget_exceeded'].includes(String(t.status))) n += 1;
      else break;
    }
    return n;
  }
}
