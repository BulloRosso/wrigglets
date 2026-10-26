import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atLeast, DEFAULT_GUARD_CONFIG, guardConfig, type GuardConfig, type SecurityAlert, type SecurityWarning } from '@cw/shared';
import type { KillSwitchService } from './killswitch.js';
import { logger } from './logger.js';
import type { AdminAudit, AgentRegistry } from './registry.js';

const MAX_ALERTS = 500;

export type RaiseInput = Omit<SecurityWarning, 'agentId'>;

/**
 * Exfiltration guard on the control plane (ADR-0033): owns the guard configuration (incl. the editable system prompt of
 * the evaluation agent) that agents fetch, and the security alerts that agents raise when the guard blocked a call.
 * An alert puts the agent on the kill-switch level of the guard (default: stopped), which cancels all its running tasks.
 */
export class SecurityGuardService {
  private config: GuardConfig = DEFAULT_GUARD_CONFIG;
  private alerts: SecurityAlert[] = [];
  private readonly configFile: string;
  private readonly alertsFile: string;
  private writing = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly registry: Pick<AgentRegistry, 'get'>,
    private readonly killSwitch: Pick<KillSwitchService, 'effective' | 'setAgent'>,
    private readonly audit: Pick<AdminAudit, 'write'>,
  ) {
    this.configFile = path.join(dataDir, 'admin', 'guard.json');
    this.alertsFile = path.join(dataDir, 'admin', 'security-alerts.json');
  }

  async load() {
    try {
      this.config = guardConfig.parse(JSON.parse(await readFile(this.configFile, 'utf8')));
    } catch {
      this.config = DEFAULT_GUARD_CONFIG;
      await this.persist(this.configFile, this.config);
    }
    try {
      this.alerts = JSON.parse(await readFile(this.alertsFile, 'utf8')) as SecurityAlert[];
    } catch {
      this.alerts = [];
    }
  }

  private persist(file: string, data: unknown) {
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
      await rename(`${file}.tmp`, file);
    });
    return this.writing;
  }

  /* ------------------------------------------------------------ configuration */

  getConfig(): GuardConfig {
    return this.config;
  }

  async setConfig(input: unknown, by: string): Promise<GuardConfig> {
    const before = this.config;
    this.config = guardConfig.parse(input);
    await this.persist(this.configFile, this.config);
    const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
    await this.audit.write({
      by,
      action: 'security.guard.config',
      target: '*',
      details: {
        enabled: this.config.enabled,
        model: this.config.model || '(platform small model)',
        failMode: this.config.failMode,
        haltLevel: this.config.haltLevel,
        contextCalls: this.config.contextCalls,
        skipTools: this.config.skipTools,
        promptChanged: before.systemPrompt !== this.config.systemPrompt,
        promptHash: hash(this.config.systemPrompt),
      },
    });
    return this.config;
  }

  /* ------------------------------------------------------------ alerts */

  list(status?: SecurityAlert['status']): SecurityAlert[] {
    return (status ? this.alerts.filter((a) => a.status === status) : this.alerts).slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  openCount(): number {
    return this.alerts.filter((a) => a.status === 'open').length;
  }

  /**
   * Records an alert (idempotent on `id`: Temporal retries the delivery) and puts the agent on the guard's halt level.
   * Returns once the alert is stored; `enforcement` settles when the kill switch has been applied (it waits for the
   * running tasks to be cancelled and can take a while).
   */
  async raise(agentId: string, input: RaiseInput): Promise<{ alert: SecurityAlert; created: boolean; enforcement: Promise<void> }> {
    const existing = this.alerts.find((a) => a.id === input.id && a.agentId === agentId);
    if (existing) return { alert: existing, created: false, enforcement: Promise.resolve() };

    const alert: SecurityAlert = { ...input, agentId, status: 'open', receivedAt: new Date().toISOString() };
    this.alerts = [alert, ...this.alerts].slice(0, MAX_ALERTS);
    await this.persist(this.alertsFile, this.alerts);
    logger.error({ agentId, alertId: alert.id, taskId: alert.taskId, tool: alert.tool, category: alert.category, reason: alert.reason }, 'SECURITY ALERT: exfiltration guard blocked a tool call');
    await this.audit.write({
      by: `agent:${agentId}`,
      action: 'security.alert',
      target: agentId,
      details: { id: alert.id, taskId: alert.taskId, tool: alert.tool, call: alert.callSummary, category: alert.category, confidence: alert.confidence, reason: alert.reason, haltLevel: alert.haltLevel },
    });
    return { alert, created: true, enforcement: this.enforce(alert) };
  }

  /** Raises (never lowers) the agent's kill-switch level. */
  private async enforce(alert: SecurityAlert) {
    const { agentId, haltLevel } = alert;
    if (!this.registry.get(agentId)) return;
    if (atLeast(this.killSwitch.effective(agentId).level, haltLevel)) return;
    try {
      await this.killSwitch.setAgent(agentId, haltLevel, `Security guard: ${alert.reason}`.slice(0, 500), 'security-guard', {
        rule: 'exfiltration-guard',
        detail: `${alert.tool} in ${alert.taskId ?? 'unknown task'}`,
      });
    } catch (err) {
      logger.error({ agentId, err: String(err) }, 'could not apply the kill switch for a security alert');
    }
  }

  async acknowledge(id: string, by: string, note?: string): Promise<SecurityAlert | undefined> {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) return undefined;
    if (alert.status === 'open') {
      alert.status = 'acknowledged';
      alert.acknowledgedBy = by;
      alert.acknowledgedAt = new Date().toISOString();
      alert.note = note?.slice(0, 1000) || undefined;
      await this.persist(this.alertsFile, this.alerts);
      await this.audit.write({ by, action: 'security.alert.ack', target: alert.agentId, details: { id, note: alert.note } });
    }
    return alert;
  }
}
