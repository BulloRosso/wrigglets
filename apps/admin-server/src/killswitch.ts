import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkflowNotFoundError } from '@temporalio/client';
import { agentWorkflowId, effectiveKillSwitch, type KillLevel, type KillSwitchEntry, type KillSwitchState } from '@cw/shared';
import { q } from '@cw/shared/search-attributes';
import { logger } from './logger.js';
import type { AdminAudit, AgentRegistry } from './registry.js';
import type { AgentRuntime } from './runtime/types.js';
import type { TemporalPlatform } from './temporal/platform.js';

/**
 * Kill switch (ADR-0022). The control plane owns the state and enforces it at three points:
 *   1. MCP gateway  — pulls the state (tools_off and above: no tools, no A2A)
 *   2. AgentWorkflow — signal `setKillSwitch` (paused/stopped: no lock grants, holder suspended)
 *   3. runtime      — stopped: running tasks cancelled, container stopped
 */
export class KillSwitchService {
  private state: KillSwitchState = { global: { level: 'normal', by: 'system', at: new Date(0).toISOString() }, agents: {} };
  private readonly file: string;
  /** Called after every change (e.g. push to the MCP gateway). */
  onChange?: () => void;

  constructor(
    dataDir: string,
    private readonly registry: AgentRegistry,
    private readonly temporal: TemporalPlatform,
    private readonly runtime: AgentRuntime,
    private readonly audit: AdminAudit,
  ) {
    this.file = path.join(dataDir, 'admin', 'killswitch.json');
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8')) as KillSwitchState;
    } catch {
      await this.persist();
    }
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.state, null, 2));
    await rename(`${this.file}.tmp`, this.file);
  }

  get(): KillSwitchState {
    return this.state;
  }

  effective(agentId: string) {
    return effectiveKillSwitch(this.state, agentId);
  }

  async setGlobal(level: KillLevel, reason: string | undefined, by: string, auto?: KillSwitchEntry['auto']) {
    const before = Object.fromEntries(this.registry.list().map((a) => [a.agentId, this.effective(a.agentId).level]));
    this.state.global = { level, reason, by, at: new Date().toISOString(), auto };
    await this.persist();
    await this.audit.write({ by, action: auto ? 'killswitch.auto' : 'killswitch.global', target: '*', details: { level, reason, auto } });
    for (const spec of this.registry.list()) await this.enforce(spec.agentId, before[spec.agentId]!);
    this.onChange?.();
  }

  async setAgent(agentId: string, level: KillLevel, reason: string | undefined, by: string, auto?: KillSwitchEntry['auto']) {
    const before = this.effective(agentId).level;
    if (level === 'normal') delete this.state.agents[agentId];
    else this.state.agents[agentId] = { level, reason, by, at: new Date().toISOString(), auto };
    await this.persist();
    await this.audit.write({ by, action: auto ? 'killswitch.auto' : 'killswitch.agent', target: agentId, details: { level, reason, auto } });
    await this.enforce(agentId, before);
    this.onChange?.();
  }

  /** Re-applies the effective level to an agent (also used at start-up and after an agent boots). */
  async enforce(agentId: string, previous?: KillLevel) {
    const eff = this.effective(agentId);
    const signal = { level: eff.level, reason: eff.entry?.reason, by: eff.entry?.by ?? 'system', at: eff.entry?.at ?? new Date().toISOString() };
    try {
      await this.temporal.client!.workflow.getHandle(agentWorkflowId(agentId)).signal('setKillSwitch', signal);
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) logger.warn({ agentId, err: String(err) }, 'could not signal kill switch');
    }
    if (eff.level === 'stopped' && previous !== 'stopped') await this.stopAgent(agentId, eff.entry?.reason ?? 'kill switch');
    if (previous === 'stopped' && eff.level !== 'stopped') {
      await this.runtime.start(agentId).catch((err) => logger.warn({ agentId, err: String(err) }, 'could not restart agent'));
    }
  }

  /** Signals agents whose AgentWorkflow reports a different level than the effective one. */
  async reconcile() {
    for (const spec of this.registry.list()) {
      const eff = this.effective(spec.agentId);
      const status = await this.temporal.agentLock(spec.agentId);
      if (!status) continue;
      if ((status.killSwitch?.level ?? 'normal') !== eff.level) await this.enforce(spec.agentId, status.killSwitch?.level ?? 'normal');
    }
  }

  private async stopAgent(agentId: string, reason: string) {
    const client = this.temporal.client!;
    const query = `AgentId = ${q(agentId)} AND WorkflowType = 'taskWorkflow' AND ExecutionStatus = 'Running'`;
    const ids: string[] = [];
    for await (const w of client.workflow.list({ query })) ids.push(w.workflowId);
    // Cancellation runs the tasks' cleanup (audit export) — it is granted the lock even while stopped.
    await Promise.all(ids.map((id) => client.workflow.getHandle(id).cancel().catch(() => undefined)));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      let running = 0;
      for await (const _ of client.workflow.list({ query })) running += 1;
      if (running === 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    await this.runtime.stop(agentId).catch((err) => logger.warn({ agentId, err: String(err) }, 'could not stop container'));
    logger.warn({ agentId, cancelled: ids.length, reason }, 'agent stopped by kill switch');
  }
}
