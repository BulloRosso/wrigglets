import type { GatewayAgentConfig } from '@cw/shared';

export type OboTokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; code: string; message: string };

/**
 * Asks an agent for a short-lived Entra token for one upstream call (ADR-0032). The agent holds its own
 * Entra credential and the user's sign-in; the gateway never sees either, only the resulting access token,
 * which it uses for that single call and does not store.
 */
export class OboClient {
  constructor(
    private readonly gatewayToken: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async token(agent: Pick<GatewayAgentConfig, 'url'>, req: { mode: 'obo' | 'agent-only'; scope: string; oid?: string }): Promise<OboTokenResult> {
    try {
      const res = await this.doFetch(`${agent.url}/internal/obo-token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.gatewayToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { accessToken?: string; expiresAt?: number; code?: string; message?: string };
      if (res.ok && body.accessToken) return { ok: true, accessToken: body.accessToken, expiresAt: body.expiresAt ?? 0 };
      return { ok: false, code: body.code ?? 'exchange_failed', message: body.message ?? `The agent could not provide a token (${res.status}).` };
    } catch {
      return { ok: false, code: 'agent_unreachable', message: 'The agent could not be reached to obtain an Entra token.' };
    }
  }
}
