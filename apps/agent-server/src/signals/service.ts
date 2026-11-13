import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkflowExecutionAlreadyStartedError, type Client, type WorkflowExecutionInfo } from '@temporalio/client';
import { ulid } from 'ulid';
import {
  DEFAULT_SIGNALS_AGENT_CONFIG,
  EXPECTATION_ID_PATTERN,
  SIGNALS_LIMITS,
  formatUsd,
  signalsAgentConfig,
  type CorrectionRecord,
  type ExpectationListItem,
  type ExpectationState,
  type InterpretResult,
  type ObservationBody,
  type SignalsAgentConfig,
} from '@cw/shared';
import { SA, q } from '@cw/shared/search-attributes';
import { expectationStateQuery, type InterpretOutput, type ObservationWorkflowInput, type OpenExpectationSummary } from '@cw/signals';
import type { AppAuditLog } from '../api/appAudit.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import type { SpendClient } from '../spend.js';
import { buildInterpretMessages, interpret } from './interpret.js';
import { SignalsStore } from './store.js';

/*
 * Signals on the agent (ADR-0037). The control plane owns the per-agent settings (switched on/off, brief, owner,
 * thresholds); the agent fetches them like the guard configuration. Expectations are Temporal workflows in the agent's
 * namespace and task queue; this service starts observation workflows, lists expectations and runs the interpreter.
 */

export class SignalsDisabledError extends Error {
  constructor() {
    super('Signals is not switched on for this agent');
  }
}
export class SignalsLimitError extends Error {}
export class SignalsAiError extends Error {}
export class SignalsInputError extends Error {}

export interface SignalsDeps {
  config: Pick<
    Config,
    'AGENT_ID' | 'AGENT_DISPLAY_NAME' | 'AGENT_DESCRIPTION' | 'CONTROL_PLANE_URL' | 'CONTROL_PLANE_TOKEN' | 'AI_GATEWAY_BASE_URL' | 'AI_GATEWAY_API_KEY' | 'AI_GATEWAY_MODEL' | 'AI_GATEWAY_SMALL_MODEL' | 'artifactsDir' | 'workspaceDir' | 'taskQueue'
  >;
  temporal: () => Client;
  audit: Pick<AppAuditLog, 'write'>;
  spend: Pick<SpendClient, 'get'>;
  fetch?: typeof fetch;
}

const CONFIG_TTL_MS = 20_000;

export class SignalsService {
  readonly store: SignalsStore;
  private cached?: { at: number; value: SignalsAgentConfig };
  private readonly recent: number[] = [];

  constructor(private readonly deps: SignalsDeps) {
    this.store = new SignalsStore(deps.config.artifactsDir);
  }

  /* ------------------------------------------------------------ configuration (owned by the control plane) */

  async getConfig(): Promise<SignalsAgentConfig> {
    if (this.cached && Date.now() - this.cached.at < CONFIG_TTL_MS) return this.cached.value;
    const { CONTROL_PLANE_URL: base, CONTROL_PLANE_TOKEN: token, AGENT_ID } = this.deps.config;
    if (!base || !token) return (this.cached = { at: Date.now(), value: DEFAULT_SIGNALS_AGENT_CONFIG }).value;
    try {
      const res = await (this.deps.fetch ?? fetch)(`${base}/internal/agents/${encodeURIComponent(AGENT_ID)}/signals-config`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      // 404: the control plane has no Signals module (overlay not started) → off
      const value = res.status === 404 ? DEFAULT_SIGNALS_AGENT_CONFIG : res.ok ? signalsAgentConfig.parse(await res.json()) : undefined;
      if (!value) throw new Error(`control plane returned ${res.status}`);
      this.cached = { at: Date.now(), value };
    } catch (err) {
      logger.warn({ err: String(err) }, 'signals configuration not fetched');
      this.cached = { at: Date.now() - CONFIG_TTL_MS + 5_000, value: this.cached?.value ?? DEFAULT_SIGNALS_AGENT_CONFIG };
    }
    return this.cached.value;
  }

  async requireEnabled(): Promise<SignalsAgentConfig> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) throw new SignalsDisabledError();
    return cfg;
  }

  /* ------------------------------------------------------------ observations */

  /** Workflow id of an observation: the same mail (Message-ID) or the same text from the same source is processed once. */
  observationId(o: ObservationBody, unique = false): string {
    if (unique) return `sig-obs-${this.deps.config.AGENT_ID}-u${ulid().toLowerCase()}`;
    const key = o.ref ? `${o.source}|ref|${o.ref}` : `${o.source}|${o.from ?? ''}|${o.subject ?? ''}|${o.body}`;
    return `sig-obs-${this.deps.config.AGENT_ID}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
  }

  private rateLimit(cfg: SignalsAgentConfig) {
    const now = Date.now();
    while (this.recent.length && this.recent[0]! < now - 3_600_000) this.recent.shift();
    if (this.recent.length >= cfg.maxObservationsPerHour) throw new SignalsLimitError(`More than ${cfg.maxObservationsPerHour} observations in the last hour; try again later`);
    this.recent.push(now);
  }

  /** Starts the observation workflow. Returns `duplicate: true` if the same observation was already handed in. */
  async observe(o: ObservationBody, by: string, opts: { preInterpreted?: InterpretResult; unique?: boolean } = {}): Promise<{ observationId: string; duplicate: boolean }> {
    const cfg = await this.requireEnabled();
    const observationId = this.observationId(o, opts.unique);
    const input: ObservationWorkflowInput = {
      agentId: this.deps.config.AGENT_ID,
      observation: { ...o, receivedAt: o.receivedAt ?? new Date().toISOString() },
      by,
      preInterpreted: opts.preInterpreted,
      settings: { fulfilThreshold: cfg.fulfilThreshold, defaultAction: cfg.defaultAction, graceDays: cfg.graceDays },
    };
    this.rateLimit(cfg);
    try {
      await this.deps.temporal().workflow.start('observationWorkflow', {
        workflowId: observationId,
        taskQueue: this.deps.config.taskQueue,
        args: [input],
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        typedSearchAttributes: [
          { key: SA.AgentId, value: this.deps.config.AGENT_ID },
          { key: SA.SignalSource, value: o.source },
          { key: SA.TaskTitle, value: (o.subject || o.body).slice(0, 200) },
        ],
        staticSummary: `Observation (${o.source}): ${(o.subject || o.body).slice(0, 150)}`,
      });
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) return { observationId, duplicate: true };
      throw err;
    }
    await this.deps.audit.write({ by, action: 'signals.observe', target: observationId, details: { source: o.source, ref: o.ref, subject: o.subject?.slice(0, 120), reviewed: !!opts.preInterpreted } });
    return { observationId, duplicate: false };
  }

  /* ------------------------------------------------------------ interpretation */

  private async role(): Promise<string | undefined> {
    return readFile(path.join(this.deps.config.workspaceDir, 'AGENTS.md'), 'utf8').catch(() => undefined);
  }

  /** The model call (used by the observation workflow's activity and by the playground's dry run). */
  async interpret(o: ObservationBody & { receivedAt?: string }, open: OpenExpectationSummary[], override?: { brief?: string }): Promise<InterpretOutput> {
    const c = this.deps.config;
    const cfg = await this.getConfig();
    const spend = await this.deps.spend.get().catch(() => undefined);
    if (spend && !spend.ai.configured) throw new SignalsAiError(`No AI model available: ${spend.ai.problem ?? 'not configured'}. ${spend.ai.howToFix ?? ''}`.trim());
    if (spend?.exceeded) throw new SignalsAiError(`${c.AGENT_DISPLAY_NAME} has reached the spend limit of ${formatUsd(spend.limitUsd)} for the last ${spend.windowDays} days.`);
    const corrections = await this.store.corrections(SIGNALS_LIMITS.corrections).catch(() => [] as CorrectionRecord[]);
    const messages = buildInterpretMessages(
      { agentName: c.AGENT_DISPLAY_NAME, agentDescription: c.AGENT_DESCRIPTION, role: await this.role(), config: { brief: override?.brief?.trim() || cfg.brief }, corrections, now: new Date() },
      o,
      open,
    );
    const model = cfg.model || c.AI_GATEWAY_SMALL_MODEL || c.AI_GATEWAY_MODEL;
    return interpret({ baseUrl: c.AI_GATEWAY_BASE_URL, apiKey: c.AI_GATEWAY_API_KEY, model, fetch: this.deps.fetch }, messages, open);
  }

  /* ------------------------------------------------------------ expectations */

  private agentQuery(extra: string) {
    return `WorkflowType = 'expectationWorkflow' AND AgentId = ${q(this.deps.config.AGENT_ID)}${extra ? ` AND ${extra}` : ''}`;
  }

  private async listExecutions(query: string, limit: number): Promise<WorkflowExecutionInfo[]> {
    const out: WorkflowExecutionInfo[] = [];
    for await (const w of this.deps.temporal().workflow.list({ query, pageSize: Math.min(limit, 100) })) {
      out.push(w);
      if (out.length >= limit) break;
    }
    return out;
  }

  async listOpen(): Promise<OpenExpectationSummary[]> {
    const running = await this.listExecutions(this.agentQuery(`ExecutionStatus = 'Running'`), SIGNALS_LIMITS.maxOpen + 20);
    const out: OpenExpectationSummary[] = [];
    // The model needs title, hint and description: query the workflows (small state, in parallel batches)
    for (let i = 0; i < running.length; i += 20) {
      const batch = await Promise.all(
        running.slice(i, i + 20).map((w) =>
          this.deps
            .temporal()
            .workflow.getHandle(w.workflowId)
            .query(expectationStateQuery)
            .catch(() => undefined),
        ),
      );
      for (const s of batch) {
        if (s && (s.state === 'open' || s.state === 'signalled')) out.push({ id: s.id, title: s.title, description: s.description, matchHint: s.matchHint, dueAt: s.dueAt, state: s.state });
      }
    }
    return out;
  }

  async list(status: 'open' | 'closed' | 'all', limit: number): Promise<ExpectationListItem[]> {
    const extra = status === 'open' ? `ExecutionStatus = 'Running'` : status === 'closed' ? `ExecutionStatus != 'Running'` : '';
    const rows = await this.listExecutions(this.agentQuery(extra), limit);
    return rows.map((w) => {
      const sa = w.typedSearchAttributes;
      const due = sa.get(SA.SignalDue);
      return {
        id: w.workflowId,
        title: sa.get(SA.TaskTitle) ?? w.workflowId,
        state: sa.get(SA.SignalState) ?? w.status.name.toLowerCase(),
        dueAt: due ? new Date(due).toISOString() : undefined,
        source: sa.get(SA.SignalSource),
        startTime: w.startTime.toISOString(),
        closeTime: w.closeTime?.toISOString(),
      };
    });
  }

  handle(id: string) {
    if (!EXPECTATION_ID_PATTERN.test(id)) throw new SignalsInputError('invalid expectation id');
    return this.deps.temporal().workflow.getHandle(id);
  }

  async state(id: string): Promise<ExpectationState> {
    return this.handle(id).query(expectationStateQuery);
  }

  async recordCorrection(c: Omit<CorrectionRecord, 'at'>) {
    await this.store.appendCorrection({ at: new Date().toISOString(), ...c });
  }
}
