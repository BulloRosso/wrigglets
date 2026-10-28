import type { DelegationStatus, Identity } from '@cw/shared';
import { logger } from './logger.js';

/** The agent's side of the MCP gateway's REST API (agent token). */
export class GatewayClient {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly agentId: string,
    private readonly token: string | undefined,
  ) {}

  get enabled() {
    return !!this.baseUrl && !!this.token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}/agents/${encodeURIComponent(this.agentId)}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** What the agent works on right now (steps are serialized per agent). Best effort. */
  async setStepContext(ctx: { taskId: string; requestedBy?: Identity; interactive?: boolean; phase?: string } | undefined) {
    if (!this.enabled) return;
    try {
      await this.call('PUT', '/step-context', ctx ?? {});
    } catch (err) {
      logger.debug({ err: String(err) }, 'gateway step context not updated');
    }
  }

  private readOnly?: { at: number; names: Set<string> };

  /** Tools (as the harness names them: `gateway_<upstream>__<tool>`) that their MCP server declares read-only. Cached for a minute. */
  async readOnlyTools(): Promise<Set<string>> {
    if (this.readOnly && Date.now() - this.readOnly.at < 60_000) return this.readOnly.names;
    if (!this.enabled) return new Set();
    const res = await this.call('GET', '/tools/read-only');
    if (!res.ok) throw new Error(`gateway returned ${res.status}`);
    const names = new Set(((await res.json()) as { tools: string[] }).tools.map((t) => `gateway_${t}`));
    this.readOnly = { at: Date.now(), names };
    return names;
  }

  async delegationStatus(delegations: Array<{ agentId: string; taskId: string }>): Promise<DelegationStatus[]> {
    if (!this.enabled) throw new Error('No MCP gateway configured');
    const res = await this.call('POST', '/a2a/status', { delegations });
    if (!res.ok) throw new Error(`gateway returned ${res.status}`);
    return (await res.json()) as DelegationStatus[];
  }
}
