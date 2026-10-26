import type { Express, RequestHandler } from 'express';
import { createOidcRp, escapeHtml } from '@cw/auth-rp';
import type { Principal } from '@cw/shared';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import type { Obo } from '../obo/index.js';

export { requireRole } from '@cw/auth-rp';

/*
 * Identity is derived server-side only (spec §2.2 #4). Three modes:
 *  - oidc     : local OAuth server (or any OIDC provider, e.g. Entra ID) — ADR-0004
 *  - easyauth : App Service EasyAuth headers (spec §9.1)
 *  - dev      : fake user, NODE_ENV=development only
 */

export interface Auth {
  middleware: RequestHandler;
  routes: (app: Express) => void;
}

/* ------------------------------------------------------------------ EasyAuth */

export function parseEasyAuthPrincipal(raw: string): Principal | undefined {
  const p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as {
    name_typ?: string;
    role_typ?: string;
    claims: Array<{ typ: string; val: string }>;
  };
  const claim = (t?: string) => (t ? p.claims.find((c) => c.typ === t)?.val : undefined);
  const roles = p.claims.filter((c) => c.typ === 'roles' || c.typ === p.role_typ).map((c) => c.val);
  const user: Principal = {
    upn: (claim('preferred_username') ?? claim(p.name_typ) ?? '').toLowerCase(),
    name: claim('name') ?? '',
    oid: claim('http://schemas.microsoft.com/identity/claims/objectidentifier') ?? claim('oid') ?? '',
    roles,
  };
  return user.upn && user.oid ? user : undefined;
}

function easyAuth(): Auth {
  return {
    routes: () => undefined,
    middleware: (req, res, next) => {
      const raw = req.header('x-ms-client-principal');
      if (!raw) return res.status(401).json({ error: 'unauthenticated' });
      try {
        const user = parseEasyAuthPrincipal(raw);
        if (!user) return res.status(401).json({ error: 'unauthenticated' });
        req.user = user;
        next();
      } catch {
        res.status(401).json({ error: 'invalid principal' });
      }
    },
  };
}

/* ------------------------------------------------------------------ dev */

function devAuth(config: Config): Auth {
  const upn = (config.DEV_FAKE_USER ?? 'dev@example.local').toLowerCase();
  return {
    routes: () => undefined,
    middleware: (req, _res, next) => {
      req.user = { upn, name: upn.split('@')[0]!, oid: `dev-${upn}`, roles: config.devFakeRoles };
      next();
    },
  };
}

/* ------------------------------------------------------------------ OIDC */

function oidcAuth(config: Config, obo?: Obo): Auth {
  const rp = createOidcRp({
    issuer: config.OIDC_ISSUER!,
    internalUrl: config.OIDC_INTERNAL_URL,
    // With Entra OBO the agent signs users in as its Entra application (same identity as in the exchange)
    clientId: obo ? config.ENTRA_CLIENT_ID! : config.OIDC_CLIENT_ID!,
    clientSecret: config.OIDC_CLIENT_SECRET!,
    scopes: obo ? `${config.OIDC_SCOPES} offline_access ${obo.userScope}` : config.OIDC_SCOPES,
    clientAuth: obo ? () => obo.client.clientAuthParams() : undefined,
    onTokens: obo
      ? async (user, t) => {
          if (!t.accessToken) return logger.warn({ upn: user.upn }, 'Entra sign-in returned no access token for the agent API; OBO will not work for this user');
          try {
            await obo.service.saveSignIn(user.oid, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt ?? Date.now() + 3_600_000, upn: user.upn });
          } catch (err) {
            logger.error({ err: String(err) }, 'could not store Entra tokens'); // sign-in itself still works
          }
        }
      : undefined,
    onSignOut: obo ? (user) => obo.service.signOut(user.oid) : undefined,
    sessionSecret: config.SESSION_SECRET!,
    sessionTtlMs: config.sessionTtlMs,
    cookieName: `cw_${config.AGENT_ID.replace(/-/g, '_')}`,
    publicBaseUrl: config.publicBaseUrl,
    requiredRole: config.roles.user,
    accessDenied: (user) =>
      `<p>${escapeHtml(user.name)}, you do not have access to the agent "${escapeHtml(config.AGENT_DISPLAY_NAME)}". Ask an administrator to grant you the role ${escapeHtml(config.roles.user)}.</p><p><a href="/auth/logout">Sign out</a></p>`,
    onSignIn: (user) => logger.info({ upn: user.upn, roles: user.roles }, 'signed in'),
  });
  return { routes: rp.routes, middleware: rp.middleware };
}

export function createAuth(config: Config, obo?: Obo): Auth {
  switch (config.AUTH_MODE) {
    case 'easyauth':
      return easyAuth();
    case 'dev':
      return devAuth(config);
    default:
      return oidcAuth(config, obo);
  }
}
