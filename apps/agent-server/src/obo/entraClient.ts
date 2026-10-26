import { X509Certificate, createPrivateKey, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';

/*
 * Minimal Microsoft Entra ID token client for the agent's confidential-client identity (ADR-0032):
 * On-Behalf-Of, client credentials and refresh-token grants. Talks to the v2.0 token endpoint directly.
 * Token values are never logged; errors carry only the OAuth error code.
 */

export interface EntraClientOptions {
  authorityHost: string;
  tenantId: string;
  clientId: string;
  credential: { kind: 'secret'; secret: string } | { kind: 'cert'; pem: string } | { kind: 'federated'; tokenFile: string };
  fetch?: typeof fetch;
}

export interface EntraToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshToken?: string;
}

/** `code` is the OAuth error (e.g. `invalid_grant`, `interaction_required`) or `network`. */
export class EntraError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Entra token request failed: ${code}${status ? ` (${status})` : ''}`);
  }
  /** The user must sign in again (revoked/expired refresh token, conditional access, consent needed). */
  get needsUserInteraction() {
    return ['invalid_grant', 'interaction_required', 'consent_required', 'login_required'].includes(this.code);
  }
}

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export class EntraClient {
  private readonly endpoint: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly o: EntraClientOptions) {
    this.endpoint = `${o.authorityHost.replace(/\/$/, '')}/${encodeURIComponent(o.tenantId)}/oauth2/v2.0/token`;
    this.doFetch = o.fetch ?? fetch;
  }

  /** Token for `scope` carrying the agent (client) and the user behind `userAssertion`. */
  onBehalfOf(userAssertion: string, scope: string): Promise<EntraToken> {
    return this.request({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: userAssertion, requested_token_use: 'on_behalf_of', scope });
  }

  /** Agent-only token (no user), for non-interactive tasks. */
  clientCredentials(scope: string): Promise<EntraToken> {
    return this.request({ grant_type: 'client_credentials', scope });
  }

  refresh(refreshToken: string, scope: string): Promise<EntraToken> {
    return this.request({ grant_type: 'refresh_token', refresh_token: refreshToken, scope });
  }

  async clientAuthParams(): Promise<Record<string, string>> {
    const c = this.o.credential;
    if (c.kind === 'secret') return { client_secret: c.secret };
    const assertion = c.kind === 'federated' ? (await readFile(c.tokenFile, 'utf8')).trim() : await this.certAssertion(c.pem);
    return { client_assertion_type: JWT_BEARER, client_assertion: assertion };
  }

  private certAssertion(pem: string) {
    const thumbprint = Buffer.from(new X509Certificate(pem).fingerprint256.replace(/:/g, ''), 'hex').toString('base64url');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', 'x5t#S256': thumbprint })
      .setIssuer(this.o.clientId)
      .setSubject(this.o.clientId)
      .setAudience(this.endpoint)
      .setJti(randomUUID())
      .setNotBefore('0s')
      .setExpirationTime('10m')
      .sign(createPrivateKey(pem));
  }

  private async request(params: Record<string, string>): Promise<EntraToken> {
    let res: Response;
    try {
      res = await this.doFetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.o.clientId, ...(await this.clientAuthParams()), ...params }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new EntraError('network');
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new EntraError(body.error ?? 'invalid_response', res.status);
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  }
}
