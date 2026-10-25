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
  async setStepContext(ctx: { taskId: string; requestedBy?: Identity } | undefined) {
    if (!this.enabled) return;
    try {
      await this.call('PUT', '/step-context', ctx ?? {});
    } catch (err) {
      logger.debug({ err: String(err) }, 'gateway step context not updated');
    }
  }

  async delegationStatus(delegations: Array<{ agentId: string; taskId: string }>): Promise<DelegationStatus[]> {
    if (!this.enabled) throw new Error('No MCP gateway configured');
    const res = await this.call('POST', '/a2a/status', { delegations });
    if (!res.ok) throw new Error(`gateway returned ${res.status}`);
    return (await res.json()) as DelegationStatus[];
  }
}
