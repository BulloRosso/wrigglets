import { createHash, randomBytes } from 'node:crypto';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { EncryptJWT, createRemoteJWKSet, jwtDecrypt, jwtVerify, type JWTPayload } from 'jose';
import type { Principal } from '@cw/shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Principal;
    }
  }
}

/*
 * OpenID Connect relying party (authorization code flow + PKCE + nonce) with a stateless,
 * encrypted session cookie (JWE, A256GCM). Works with the local OAuth server and with any
 * standard OIDC provider such as Microsoft Entra ID (ADR-0004).
 *
 * Split-horizon URLs: browsers reach the provider under `issuer` (e.g. http://localhost:9000),
 * containers under `internalUrl` (e.g. http://oauth:9000). Back-channel calls (discovery, token,
 * JWKS) are rewritten to the internal URL; the `iss` claim is still validated against `issuer`.
 */

export interface OidcRpOptions {
  issuer: string;
  internalUrl?: string;
  clientId: string;
  clientSecret: string;
  scopes?: string;
  /** Used to derive the cookie encryption key (min. 32 chars). */
  sessionSecret: string;
  sessionTtlMs: number;
  cookieName: string;
  /** Public base URL of this application (redirect URI = `${publicBaseUrl}/auth/callback`). */
  publicBaseUrl: string;
  /** Role required to sign in; users without it get `accessDenied(user)`. */
  requiredRole?: string;
  accessDenied?: (user: Principal) => string;
  onSignIn?: (user: Principal) => void;
}

export interface OidcRp {
  routes(app: Express): void;
  middleware: RequestHandler;
  /** For APIs that must not redirect (always 401). */
  apiMiddleware: RequestHandler;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function createOidcRp(o: OidcRpOptions): OidcRp {
  const issuer = o.issuer.replace(/\/$/, '');
  const internal = (o.internalUrl ?? issuer).replace(/\/$/, '');
  const toInternal = (url: string) => (url.startsWith(issuer) ? internal + url.slice(issuer.length) : url);
  // oidc-provider derives endpoint URLs from the request host: discovery fetched via the internal
  // URL lists internal endpoints. Browser-facing endpoints must use the public issuer URL.
  const toPublic = (url: string) => (url.startsWith(internal) ? issuer + url.slice(internal.length) : url);
  const key = createHash('sha256').update(o.sessionSecret).digest();
  const flowCookie = `${o.cookieName}_flow`;
  const base = o.publicBaseUrl.replace(/\/$/, '');
  const secure = base.startsWith('https://');
  const redirectUri = `${base}/auth/callback`;
  let discovery: Discovery | undefined;
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  async function discover(): Promise<Discovery> {
    if (discovery) return discovery;
    const res = await fetch(`${internal}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    discovery = (await res.json()) as Discovery;
    jwks = createRemoteJWKSet(new URL(toInternal(discovery.jwks_uri)));
    return discovery;
  }

  const seal = (payload: JWTPayload, ttlSeconds: number) =>
    new EncryptJWT(payload).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setIssuedAt().setExpirationTime(`${ttlSeconds}s`).encrypt(key);
  async function unseal<T>(token: string | undefined): Promise<T | undefined> {
    if (!token) return undefined;
    try {
      return (await jwtDecrypt(token, key)).payload as T;
    } catch {
      return undefined;
    }
  }
  const cookieOpts = (maxAge: number) => ({ httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge });
  const safeReturnTo = (v: unknown) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');

  async function sessionUser(req: Request): Promise<Principal | undefined> {
    const s = await unseal<Principal>(req.cookies?.[o.cookieName]);
    return s ? { upn: s.upn, name: s.name, oid: s.oid, roles: s.roles ?? [] } : undefined;
  }

  const isApi = (req: Request) => req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/codec/');

  return {
    routes(app) {
      app.get('/auth/login', async (req, res, next) => {
        try {
          const d = await discover();
          const state = b64url(randomBytes(16));
          const nonce = b64url(randomBytes(16));
          const verifier = b64url(randomBytes(32));
          const challenge = b64url(createHash('sha256').update(verifier).digest());
          res.cookie(flowCookie, await seal({ state, nonce, verifier, returnTo: safeReturnTo(req.query.returnTo) }, 600), cookieOpts(600_000));
          const url = new URL(toPublic(d.authorization_endpoint));
          url.search = new URLSearchParams({
            client_id: o.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: o.scopes ?? 'openid profile email',
            state,
            nonce,
            code_challenge: challenge,
            code_challenge_method: 'S256',
          }).toString();
          res.redirect(url.toString());
        } catch (err) {
          next(err);
        }
      });

      app.get('/auth/callback', async (req, res, next) => {
        try {
          const flow = await unseal<{ state: string; nonce: string; verifier: string; returnTo: string }>(req.cookies?.[flowCookie]);
          res.clearCookie(flowCookie, { path: '/' });
          if (req.query.error) {
            return res.status(401).type('html').send(`<p>Sign-in was not completed: ${escapeHtml(String(req.query.error_description ?? req.query.error))}</p><p><a href="/auth/login">Try again</a></p>`);
          }
          if (!flow || flow.state !== req.query.state || typeof req.query.code !== 'string') return res.redirect('/auth/login');
          const d = await discover();
          const tokenRes = await fetch(toInternal(d.token_endpoint), {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              authorization: `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString('base64')}`,
            },
            body: new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri, code_verifier: flow.verifier }),
          });
          if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
          const tokens = (await tokenRes.json()) as { id_token?: string };
          if (!tokens.id_token) throw new Error('no id_token in token response');
          const { payload } = await jwtVerify(tokens.id_token, jwks!, { issuer: d.issuer, audience: o.clientId });
          if (payload.nonce !== flow.nonce) throw new Error('nonce mismatch');
          const user: Principal = {
            upn: String(payload.preferred_username ?? payload.email ?? payload.sub).toLowerCase(),
            name: String(payload.name ?? payload.preferred_username ?? payload.sub),
            oid: String(payload.oid ?? payload.sub),
            roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
          };
          if (o.requiredRole && !user.roles.includes(o.requiredRole)) {
            return res.status(403).type('html').send(o.accessDenied?.(user) ?? `<p>Access denied (role ${escapeHtml(o.requiredRole)} required).</p><p><a href="/auth/logout">Sign out</a></p>`);
          }
          res.cookie(o.cookieName, await seal({ ...user }, Math.floor(o.sessionTtlMs / 1000)), cookieOpts(o.sessionTtlMs));
          o.onSignIn?.(user);
          res.redirect(flow.returnTo);
        } catch (err) {
          next(err);
        }
      });

      app.get('/auth/logout', async (_req, res) => {
        res.clearCookie(o.cookieName, { path: '/' });
        const d = await discover().catch(() => undefined);
        if (!d?.end_session_endpoint) return res.redirect('/');
        const url = new URL(toPublic(d.end_session_endpoint));
        url.search = new URLSearchParams({ client_id: o.clientId, post_logout_redirect_uri: `${base}/` }).toString();
        res.redirect(url.toString());
      });
    },

    async middleware(req: Request, res: Response, next: NextFunction) {
      const user = await sessionUser(req);
      if (!user) {
        if (isApi(req) || req.method !== 'GET') return res.status(401).json({ error: 'unauthenticated' });
        return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
      }
      req.user = user;
      next();
    },

    async apiMiddleware(req: Request, res: Response, next: NextFunction) {
      const user = await sessionUser(req);
      if (!user) return res.status(401).json({ error: 'unauthenticated' });
      req.user = user;
      next();
    },
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function requireRole(...roles: string[]): RequestHandler {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!roles.some((r) => req.user!.roles.includes(r))) return res.status(403).json({ error: `requires role ${roles.join(' or ')}` });
    next();
  };
}
