import type { AgentSpend } from '@cw/shared';
import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * Spend of this agent's LiteLLM virtual key over the last 30 days, as computed by the control plane from the LiteLLM
 * API (ADR-0029). Used for the budget check before every step and shown to users.
 */
export class SpendClient {
  private cached?: { at: number; value: AgentSpend };

  constructor(private readonly config: Pick<Config, 'CONTROL_PLANE_URL' | 'CONTROL_PLANE_TOKEN' | 'AGENT_ID'>) {}

  get enabled() {
    return !!this.config.CONTROL_PLANE_URL && !!this.config.CONTROL_PLANE_TOKEN;
  }

  /** Undefined when the control plane cannot be asked (then LiteLLM's own key budget still applies). */
  async get(opts: { maxAgeMs?: number } = {}): Promise<AgentSpend | undefined> {
    const maxAge = opts.maxAgeMs ?? 15_000;
    if (this.cached && Date.now() - this.cached.at < maxAge) return this.cached.value;
    if (!this.enabled) return undefined;
    try {
      const res = await fetch(`${this.config.CONTROL_PLANE_URL}/internal/agents/${encodeURIComponent(this.config.AGENT_ID)}/spend`, {
        headers: { authorization: `Bearer ${this.config.CONTROL_PLANE_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`control plane returned ${res.status}`);
      const value = (await res.json()) as AgentSpend;
      this.cached = { at: Date.now(), value };
      return value;
    } catch (err) {
      logger.warn({ err: String(err) }, 'spend not available');
      return this.cached?.value;
    }
  }
}
