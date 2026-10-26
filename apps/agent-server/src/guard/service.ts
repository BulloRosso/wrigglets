import { randomBytes } from 'node:crypto';
import type { Client } from '@temporalio/client';
import { agentWorkflowId, DEFAULT_GUARD_CONFIG, guardConfig, type GuardConfig, type GuardVerdict, type Principal, type SecurityWarning } from '@cw/shared';
import { cancelUpdate, securityWarningSignal } from '@cw/workflows/messages';
import { ulid } from 'ulid';
import type { AppAuditLog } from '../api/appAudit.js';
import type { Config } from '../config.js';
import type { HarnessClient } from '../harness/client.js';
import { logger } from '../logger.js';
import { buildGuardPrompt, parseVerdict, summarizeCall } from './context.js';
import { postSecurityAlert } from './report.js';

/*
 * Exfiltration guard (ADR-0033). The opencode plugin forwards every tool call to `evaluate` BEFORE it runs. A small model
 * (the evaluation agent) judges the call against the last model round-trips of the task conversation. On a block:
 *   1. the call is refused (the plugin throws, so the tool never runs),
 *   2. the user's task is cancelled and the harness session aborted,
 *   3. a security warning goes to the agent's AgentWorkflow in Temporal, which stops the agent and tells the control
 *      plane (admin dashboard alert).
 */

export interface GuardRequest {
  sessionID: string;
  callID: string;
  tool: string;
  args: unknown;
}

export interface GuardDecision {
  decision: 'allow' | 'block';
  message?: string;
}

export interface GuardDeps {
  config: Pick<Config, 'AGENT_ID' | 'CONTROL_PLANE_URL' | 'CONTROL_PLANE_TOKEN' | 'AI_GATEWAY_BASE_URL' | 'AI_GATEWAY_API_KEY' | 'AI_GATEWAY_MODEL' | 'AI_GATEWAY_SMALL_MODEL'>;
  harness: Pick<HarnessClient, 'messages' | 'abort'>;
  /** Which task a harness session is working for right now. */
  stepOf: (sessionId: string) => { taskId: string; stepId: string } | undefined;
  temporal: () => Client | undefined;
  audit: Pick<AppAuditLog, 'write'>;
  fetch?: typeof fetch;
}

const GUARD_PRINCIPAL: Principal = { upn: 'security-guard', name: 'Security guard', oid: 'security-guard', roles: [] };
const CONFIG_TTL_MS = 20_000;
const MODEL_TIMEOUT_MS = 30_000;

export class GuardService {
  /** Shared secret between the harness plugin and this process (random per boot, loopback only). */
  readonly token = randomBytes(32).toString('hex');
  private cached?: { at: number; value: GuardConfig };
  private readonly halted = new Map<string, SecurityWarning>();
  /** Tool calls the plugin has sent per harness session — proves that the hook is active. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly deps: GuardDeps) {}

  /** Endpoint and token the supervisor hands to the harness plugin. */
  connection(port: number) {
    return { url: `http://127.0.0.1:${port}/internal/guard/evaluate`, token: this.token };
  }

  /* ------------------------------------------------------------ configuration (owned by the control plane) */

  async getConfig(): Promise<GuardConfig> {
    if (this.cached && Date.now() - this.cached.at < CONFIG_TTL_MS) return this.cached.value;
    const { CONTROL_PLANE_URL: base, CONTROL_PLANE_TOKEN: token, AGENT_ID } = this.deps.config;
    if (!base || !token) return (this.cached = { at: Date.now(), value: DEFAULT_GUARD_CONFIG }).value;
    try {
      const res = await (this.deps.fetch ?? fetch)(`${base}/internal/agents/${encodeURIComponent(AGENT_ID)}/guard-config`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`control plane returned ${res.status}`);
      this.cached = { at: Date.now(), value: guardConfig.parse(await res.json()) };
    } catch (err) {
      // Keep the last known policy; before the first successful fetch the default policy applies (guard on).
      logger.warn({ err: String(err) }, 'guard configuration not fetched');
      this.cached = { at: Date.now() - CONFIG_TTL_MS + 5_000, value: this.cached?.value ?? DEFAULT_GUARD_CONFIG };
    }
    return this.cached.value;
  }

  /* ------------------------------------------------------------ halt bookkeeping for runAgentStep */

  /** The warning that stopped this harness session, if any (read by runAgentStep after the harness call returned). */
  haltOf(sessionId: string): SecurityWarning | undefined {
    return this.halted.get(sessionId);
  }

  clearHalt(sessionId: string) {
    this.halted.delete(sessionId);
  }

  /* ------------------------------------------------------------ evaluation */

  /** Number of tool calls of this session that reached the guard. */
  evaluationsOf(sessionId: string): number {
    return this.seen.get(sessionId) ?? 0;
  }

  async evaluate(req: GuardRequest): Promise<GuardDecision> {
    this.seen.set(req.sessionID, (this.seen.get(req.sessionID) ?? 0) + 1);
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!);
    const cfg = await this.getConfig();
    if (!cfg.enabled || cfg.skipTools.includes(req.tool)) return { decision: 'allow' };
    const already = this.halted.get(req.sessionID);
    if (already) return { decision: 'block', message: blockMessage(already.reason) };

    let verdict: GuardVerdict;
    const model = cfg.model || this.deps.config.AI_GATEWAY_SMALL_MODEL || this.deps.config.AI_GATEWAY_MODEL;
    try {
      const history = await this.deps.harness.messages(req.sessionID).catch(() => []);
      verdict = await this.ask(model, buildGuardPrompt(cfg, history, { callID: req.callID, tool: req.tool, args: req.args }).messages);
    } catch (err) {
      logger.warn({ tool: req.tool, err: String(err) }, 'guard evaluation failed');
      await this.deps.audit
        .write({ by: 'security-guard', action: 'guard.error', target: this.deps.stepOf(req.sessionID)?.taskId ?? req.sessionID, details: { tool: req.tool, failMode: cfg.failMode, error: String(err).slice(0, 300) } })
        .catch(() => undefined);
      // An evaluation error is not an attack: the call is refused (or let through, per policy) but nothing is halted.
      return cfg.failMode === 'allow'
        ? { decision: 'allow' }
        : { decision: 'block', message: 'The security check could not be completed, so the tool call was refused. Try again or finish without this tool.' };
    }
    if (verdict.decision === 'allow') return { decision: 'allow' };

    const step = this.deps.stepOf(req.sessionID);
    const warning: SecurityWarning = {
      id: ulid(),
      at: new Date().toISOString(),
      agentId: this.deps.config.AGENT_ID,
      taskId: step?.taskId,
      stepId: step?.stepId,
      tool: req.tool,
      callSummary: summarizeCall(req.tool, req.args),
      category: verdict.category === 'none' ? 'prompt_injection' : verdict.category,
      confidence: verdict.confidence,
      reason: verdict.reason || 'The evaluation agent blocked the call.',
      haltLevel: cfg.haltLevel === 'paused' ? 'paused' : 'stopped',
      model,
    };
    await this.halt(req.sessionID, warning);
    return { decision: 'block', message: blockMessage(warning.reason) };
  }

  private async ask(model: string, messages: Array<{ role: string; content: string }>): Promise<GuardVerdict> {
    const c = this.deps.config;
    const res = await (this.deps.fetch ?? fetch)(`${c.AI_GATEWAY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.AI_GATEWAY_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0, response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `AI gateway returned ${res.status}`);
    return parseVerdict(body.choices?.[0]?.message?.content ?? '');
  }

  /* ------------------------------------------------------------ reaction to a block */

  private async halt(sessionId: string, warning: SecurityWarning) {
    this.halted.set(sessionId, warning);
    logger.error({ taskId: warning.taskId, tool: warning.tool, category: warning.category, reason: warning.reason }, 'exfiltration guard blocked a tool call — stopping the task');
    // The task is cancelled FIRST, so that it ends as "cancelled" with the reason in its history and audit export …
    await this.cancelTask(warning).catch((err) => logger.warn({ err: String(err) }, 'could not cancel the task'));
    // … then the harness stops, and the warning goes to Temporal (which stops the agent and informs the administrator).
    await Promise.allSettled([
      this.deps.harness.abort(sessionId),
      this.warnTemporal(warning),
      this.deps.audit.write({
        by: 'security-guard',
        action: 'guard.block',
        target: warning.taskId ?? sessionId,
        details: { id: warning.id, tool: warning.tool, call: warning.callSummary, category: warning.category, confidence: warning.confidence, reason: warning.reason, model: warning.model },
      }),
    ]);
  }

  private async cancelTask(w: SecurityWarning) {
    const client = this.deps.temporal();
    if (!client || !w.taskId) return;
    await client.workflow.getHandle(w.taskId).executeUpdate(cancelUpdate, {
      args: [{ by: GUARD_PRINCIPAL, reason: `Security guard: ${w.reason}`.slice(0, 500) }],
    });
  }

  /** Signal to the lock manager in Temporal; if Temporal cannot be reached the control plane is told directly. */
  private async warnTemporal(w: SecurityWarning) {
    try {
      const client = this.deps.temporal();
      if (!client) throw new Error('no Temporal client');
      await client.workflow.getHandle(agentWorkflowId(w.agentId)).signal(securityWarningSignal, w);
    } catch (err) {
      logger.error({ err: String(err) }, 'could not signal the security warning to Temporal — reporting to the control plane directly');
      await postSecurityAlert(this.deps.config, w).catch((e) => logger.error({ err: String(e) }, 'security alert not delivered'));
    }
  }
}

const blockMessage = (reason: string) => `Blocked by the security guard: ${reason} The task has been stopped and an administrator was notified. Do not try to work around this.`;
