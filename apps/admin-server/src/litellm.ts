import { createHash } from 'node:crypto';
import { SPEND_WINDOW_DAYS, type AgentSpend, type AgentSpec, type AiKeyInfo, type AiModelInfo, type AiStatus } from '@cw/shared';
import { logger } from './logger.js';

/*
 * LiteLLM proxy as the AI gateway (ADR-0029). The control plane holds the master key and
 *   - creates one virtual key per agent (`/key/generate`) with the agent's USD limit as LiteLLM key budget (backstop),
 *   - computes the rolling 30-day spend of each key from LiteLLM's spend logs (`/spend/logs`),
 *   - reports whether a real model is usable and the current token prices (`/model/info`).
 * Agents only ever see their own virtual key.
 */

export interface LiteLLMOptions {
  url: string;
  publicUrl?: string;
  masterKey?: string;
  /** OPENAI_API_KEY is present in the machine's environment (passed to the LiteLLM container). */
  openaiKeyPresent: boolean;
  defaultModel: string;
}

const HOW_TO_FIX_KEY =
  'Set OPENAI_API_KEY in the environment of the machine that runs Docker (Windows: setx OPENAI_API_KEY "sk-…", then open a new terminal) and run "node scripts/stack.mjs up" again.';

const perMillion = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6 * 10_000) / 10_000 : undefined);
const day = (d: Date) => d.toISOString().slice(0, 10);

export class LiteLLMService {
  private statusCache?: { at: number; value: AiStatus };
  private readonly spendCache = new Map<string, { at: number; usd: number }>();
  private readonly blockedCache = new Map<string, { at: number; blocked: boolean }>();

  constructor(private readonly o: LiteLLMOptions) {}

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    if (!this.o.masterKey) throw new Error('LITELLM_MASTER_KEY is not configured');
    const res = await fetch(`${this.o.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.o.masterKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LiteLLM ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Is a real AI model usable? Cached for 30 s. */
  async status(force = false): Promise<AiStatus> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < 30_000) return this.statusCache.value;
    const base = { defaultModel: this.o.defaultModel, gatewayUrl: this.o.publicUrl ? `${this.o.publicUrl}/ui` : undefined, checkedAt: new Date().toISOString() };
    let value: AiStatus;
    try {
      const live = await fetch(`${this.o.url}/health/liveliness`, { signal: AbortSignal.timeout(3_000) });
      if (!live.ok) throw new Error(`liveliness ${live.status}`);
      const info = await this.call<{ data: Array<{ model_name: string; model_info?: Record<string, unknown> }> }>('GET', '/model/info');
      const models: AiModelInfo[] = info.data.map((m) => ({
        name: m.model_name,
        inputUsdPer1M: perMillion(m.model_info?.input_cost_per_token),
        outputUsdPer1M: perMillion(m.model_info?.output_cost_per_token),
        cachedInputUsdPer1M: perMillion(m.model_info?.cache_read_input_token_cost),
        contextTokens: typeof m.model_info?.max_input_tokens === 'number' ? (m.model_info.max_input_tokens as number) : undefined,
      }));
      if (!this.o.openaiKeyPresent) {
        value = { ...base, configured: false, reachable: true, models, problem: 'OPENAI_API_KEY is not set, so LiteLLM cannot call the OpenAI API', howToFix: HOW_TO_FIX_KEY };
      } else if (!models.some((m) => m.name === this.o.defaultModel)) {
        value = {
          ...base,
          configured: false,
          reachable: true,
          models,
          problem: `the default model "${this.o.defaultModel}" is not configured in LiteLLM`,
          howToFix: 'Add it to infra/litellm/config.yaml or set AI_GATEWAY_MODEL to one of the configured models.',
        };
      } else {
        value = { ...base, configured: true, reachable: true, models };
      }
    } catch (err) {
      value = {
        ...base,
        configured: false,
        reachable: false,
        models: [],
        problem: `the AI gateway (LiteLLM) is not reachable: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
        howToFix: this.o.masterKey
          ? 'Start it with "docker compose up -d litellm" (or "node scripts/stack.mjs up") and check "docker logs cw-litellm".'
          : 'Run "node scripts/stack.mjs env" to create CW_LITELLM_MASTER_KEY, then "node scripts/stack.mjs up".',
      };
    }
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Makes sure the agent has a virtual key with the right budget. Returns the key (new or existing).
   * The LiteLLM key budget (budget_duration 30d) is a backstop; the rolling 30-day check happens before every step.
   */
  async ensureKey(spec: AgentSpec, existing: string | undefined, limitUsd: number, models: string[] = []): Promise<string> {
    if (existing) {
      try {
        await this.call('POST', '/key/update', { key: existing, max_budget: limitUsd, models, metadata: { agentId: spec.agentId, displayName: spec.displayName } });
        return existing;
      } catch (err) {
        logger.warn({ agentId: spec.agentId, err: String(err) }, 'virtual key not found or not updatable — creating a new one');
      }
    }
    const r = await this.call<{ key: string }>('POST', '/key/generate', {
      key_alias: `agent-${spec.agentId}-${Date.now().toString(36)}`,
      max_budget: limitUsd,
      budget_duration: `${SPEND_WINDOW_DAYS}d`,
      // the key may only use the agent's models
      models,
      metadata: { agentId: spec.agentId, displayName: spec.displayName, createdBy: 'control-plane' },
    });
    logger.info({ agentId: spec.agentId, limitUsd }, 'LiteLLM virtual key created');
    return r.key;
  }

  /** Key details as LiteLLM knows them (for the admin console; the key itself is only shown masked). */
  async keyInfo(key: string): Promise<AiKeyInfo> {
    const r = await this.call<{ info: Record<string, unknown> }>('GET', `/key/info?key=${encodeURIComponent(key)}`);
    const i = r.info ?? {};
    return {
      masked: `${key.slice(0, 5)}…${key.slice(-4)}`,
      alias: typeof i.key_alias === 'string' ? i.key_alias : undefined,
      createdAt: typeof i.created_at === 'string' ? i.created_at : undefined,
      blocked: i.blocked === true,
      maxBudgetUsd: typeof i.max_budget === 'number' ? i.max_budget : undefined,
      budgetDuration: typeof i.budget_duration === 'string' ? i.budget_duration : undefined,
      budgetResetAt: typeof i.budget_reset_at === 'string' ? i.budget_reset_at : undefined,
      periodSpendUsd: typeof i.spend === 'number' ? i.spend : 0,
      models: Array.isArray(i.models) ? (i.models as string[]) : [],
    };
  }

  /** Daily spend of the key over the last 30 days (oldest first). */
  async dailySpend(key: string): Promise<Array<{ date: string; usd: number }>> {
    const hash = createHash('sha256').update(key).digest('hex');
    const end = new Date();
    const start = new Date(end.getTime() - (SPEND_WINDOW_DAYS - 1) * 86_400_000);
    const rows = await this.call<Array<Record<string, unknown>>>(
      'GET',
      `/spend/logs?api_key=${encodeURIComponent(key)}&start_date=${day(start)}&end_date=${day(new Date(end.getTime() + 86_400_000))}`,
    );
    const byDay = new Map((Array.isArray(rows) ? rows : []).map((r) => [String(r.startTime).slice(0, 10), typeof r[hash] === 'number' ? (r[hash] as number) : 0]));
    return Array.from({ length: SPEND_WINDOW_DAYS }, (_, i) => {
      const d = day(new Date(start.getTime() + i * 86_400_000));
      return { date: d, usd: byDay.get(d) ?? 0 };
    });
  }

  async setBlocked(key: string, blocked: boolean) {
    await this.call('POST', blocked ? '/key/block' : '/key/unblock', { key });
    this.blockedCache.set(key, { at: Date.now(), blocked });
  }

  /** New key for the agent (same budget and models); the old key is deleted afterwards by the caller. */
  async rotateKey(spec: AgentSpec, limitUsd: number, models: string[]): Promise<string> {
    return this.ensureKey(spec, undefined, limitUsd, models);
  }

  async deleteKey(key: string | undefined) {
    if (!key) return;
    await this.call('POST', '/key/delete', { keys: [key] }).catch((err) => logger.warn({ err: String(err) }, 'could not delete LiteLLM key'));
  }

  /** Rolling spend of a key over the last SPEND_WINDOW_DAYS days (sum of LiteLLM's daily spend logs). Cached 15 s. */
  async spend30d(key: string): Promise<number> {
    const hash = createHash('sha256').update(key).digest('hex');
    const hit = this.spendCache.get(hash);
    if (hit && Date.now() - hit.at < 15_000) return hit.usd;
    const end = new Date();
    const start = new Date(end.getTime() - (SPEND_WINDOW_DAYS - 1) * 86_400_000);
    // end_date is exclusive in LiteLLM's daily aggregation: use tomorrow
    const rows = await this.call<Array<Record<string, unknown>>>(
      'GET',
      `/spend/logs?api_key=${encodeURIComponent(key)}&start_date=${day(start)}&end_date=${day(new Date(end.getTime() + 86_400_000))}`,
    );
    const usd = (Array.isArray(rows) ? rows : []).reduce((sum, r) => sum + (typeof r[hash] === 'number' ? (r[hash] as number) : 0), 0);
    this.spendCache.set(hash, { at: Date.now(), usd });
    return usd;
  }

  async agentSpend(spec: AgentSpec, key: string | undefined, limitUsd: number): Promise<AgentSpend> {
    const ai = await this.status();
    let spentUsd = 0;
    if (key && ai.reachable) spentUsd = await this.spend30d(key).catch((err) => (logger.warn({ err: String(err) }, 'spend query failed'), 0));
    let blocked = false;
    if (key && ai.reachable) {
      const hit = this.blockedCache.get(key);
      if (hit && Date.now() - hit.at < 15_000) blocked = hit.blocked;
      else {
        blocked = await this.keyInfo(key).then((i) => i.blocked, () => false);
        this.blockedCache.set(key, { at: Date.now(), blocked });
      }
    }
    const keyProblem =
      !key && ai.configured
        ? { configured: false, problem: 'the agent has no AI key yet', howToFix: 'Redeploy the agent in the admin console.' }
        : blocked
          ? { configured: false, problem: "the agent's AI key is blocked by an administrator", howToFix: 'Unblock it in the admin console (agent → AI & budget).' }
          : {};
    return {
      agentId: spec.agentId,
      model: spec.model,
      spentUsd: Math.round(spentUsd * 1e6) / 1e6,
      limitUsd,
      remainingUsd: Math.max(0, Math.round((limitUsd - spentUsd) * 1e6) / 1e6),
      exceeded: spentUsd >= limitUsd,
      windowDays: SPEND_WINDOW_DAYS,
      since: new Date(Date.now() - SPEND_WINDOW_DAYS * 86_400_000).toISOString(),
      ai: { configured: ai.configured, reachable: ai.reachable, problem: ai.problem, howToFix: ai.howToFix, ...keyProblem },
      checkedAt: new Date().toISOString(),
    };
  }
}
