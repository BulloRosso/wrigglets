import type { EntraClient, EntraToken } from './entraClient.js';
import { EntraError } from './entraClient.js';
import type { UserTokenStore, UserTokens } from './userTokenStore.js';

export type OboMode = 'obo' | 'agent-only';
export type OboResult =
  | { ok: true; accessToken: string; expiresAt: number; mode: OboMode }
  | { ok: false; code: 'no_user_assertion' | 'interaction_required' | 'agent_only_not_allowed' | 'exchange_failed'; message: string };

/** Tokens are reused until this long before they expire. */
const SKEW_MS = 60_000;

/**
 * The agent's Entra identity towards MCP servers (ADR-0032): exchanges the signed-in user's token
 * (On-Behalf-Of) or, for non-interactive tasks and only if allowed, uses the agent alone (client credentials).
 */
export class OboService {
  private readonly issued = new Map<string, EntraToken>();

  constructor(
    private readonly client: Pick<EntraClient, 'onBehalfOf' | 'clientCredentials' | 'refresh'>,
    private readonly store: Pick<UserTokenStore, 'get' | 'put' | 'delete'>,
    private readonly o: { userScope: string; allowAgentOnly: boolean },
    private readonly now: () => number = Date.now,
  ) {}

  /** Called after a successful Entra sign-in with the tokens of the agent's own API. */
  saveSignIn(oid: string, t: UserTokens) {
    this.dropIssued(oid);
    return this.store.put(oid, t);
  }

  async signOut(oid: string) {
    this.dropIssued(oid);
    await this.store.delete(oid);
  }

  /** The user's current assertion for the OBO exchange, refreshed when needed; undefined = must sign in again. */
  private async userAssertion(oid: string): Promise<string | undefined> {
    const t = await this.store.get(oid);
    if (!t) return undefined;
    if (t.expiresAt - SKEW_MS > this.now()) return t.accessToken;
    if (!t.refreshToken) return undefined;
    try {
      const r = await this.client.refresh(t.refreshToken, this.o.userScope);
      await this.store.put(oid, { ...t, accessToken: r.accessToken, expiresAt: r.expiresAt, refreshToken: r.refreshToken ?? t.refreshToken });
      return r.accessToken;
    } catch (err) {
      if (err instanceof EntraError && err.needsUserInteraction) {
        await this.signOut(oid); // revoked or expired: do not keep a dead grant
        return undefined;
      }
      throw err;
    }
  }

  async token(req: { mode: OboMode; scope: string; oid?: string }): Promise<OboResult> {
    const key = `${req.mode}|${req.mode === 'obo' ? req.oid : ''}|${req.scope}`;
    const hit = this.issued.get(key);
    if (hit && hit.expiresAt - SKEW_MS > this.now()) return { ok: true, accessToken: hit.accessToken, expiresAt: hit.expiresAt, mode: req.mode };
    try {
      let t: EntraToken;
      if (req.mode === 'agent-only') {
        if (!this.o.allowAgentOnly) return { ok: false, code: 'agent_only_not_allowed', message: 'Agent-only tokens are not enabled for this agent.' };
        t = await this.client.clientCredentials(req.scope);
      } else {
        const assertion = req.oid ? await this.userAssertion(req.oid) : undefined;
        if (!assertion) return { ok: false, code: 'no_user_assertion', message: 'The user has no valid Entra sign-in for this agent; they must sign in again.' };
        t = await this.client.onBehalfOf(assertion, req.scope);
      }
      this.issued.set(key, t);
      return { ok: true, accessToken: t.accessToken, expiresAt: t.expiresAt, mode: req.mode };
    } catch (err) {
      if (err instanceof EntraError && err.needsUserInteraction) return { ok: false, code: 'interaction_required', message: `Entra requires the user to sign in or consent again (${err.code}).` };
      return { ok: false, code: 'exchange_failed', message: err instanceof EntraError ? `Entra token exchange failed (${err.code}).` : 'Entra token exchange failed.' };
    }
  }

  private dropIssued(oid: string) {
    for (const k of this.issued.keys()) if (k.startsWith(`obo|${oid}|`)) this.issued.delete(k);
  }
}
