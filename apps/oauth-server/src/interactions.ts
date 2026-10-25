import path from 'node:path';
import express, { Router } from 'express';
import type Provider from 'oidc-provider';
import { AGENT_ROLES, PLATFORM_ROLES } from '@cw/shared';
import type { Logger } from 'pino';
import { rolesForClient, verifyPassword, type Store } from './store.js';

/*
 * Interaction endpoints used by the sign-in SPA (apps/oauth-web).
 *   GET  /interaction/:uid          → SPA (consent is granted automatically: all clients are first-party)
 *   GET  /interaction/:uid/details  → JSON for the SPA
 *   POST /interaction/:uid/login    → verify credentials, returns { redirectTo }
 *   POST /interaction/:uid/abort    → cancel, returns { redirectTo }
 */

const failures = new Map<string, { count: number; until: number }>();

export function interactionRouter(provider: Provider, store: Store, webDir: string, log: Logger): Router {
  const r = Router();
  r.use('/interaction', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  r.get('/interaction/:uid', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name === 'consent') {
        const { prompt, params, session } = details;
        const grant = details.grantId
          ? (await provider.Grant.find(details.grantId))!
          : new provider.Grant({ accountId: session!.accountId, clientId: String(params.client_id) });
        const d = prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[]; missingResourceScopes?: Record<string, string[]> };
        if (d.missingOIDCScope) grant.addOIDCScope(d.missingOIDCScope.join(' '));
        if (d.missingOIDCClaims) grant.addOIDCClaims(d.missingOIDCClaims);
        for (const [indicator, scopes] of Object.entries(d.missingResourceScopes ?? {})) grant.addResourceScope(indicator, scopes.join(' '));
        const grantId = await grant.save();
        await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
        return;
      }
      res.sendFile(path.join(webDir, 'index.html'));
    } catch (err) {
      next(err);
    }
  });

  r.get('/interaction/:uid/details', async (req, res) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const client = await provider.Client.find(String(details.params.client_id));
      res.json({
        uid: details.uid,
        prompt: details.prompt.name,
        reason: details.prompt.reasons,
        client: { clientId: client?.clientId, name: client?.clientName ?? client?.clientId },
        loginHint: details.params.login_hint,
      });
    } catch {
      res.status(410).json({ error: 'This sign-in request has expired. Please start again from the application.' });
    }
  });

  r.post('/interaction/:uid/login', express.json(), async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const lock = failures.get(email);
    if (lock && lock.until > Date.now()) return res.status(429).json({ error: 'Too many failed attempts. Try again in a minute.' });

    let details;
    try {
      details = await provider.interactionDetails(req, res);
    } catch {
      return res.status(410).json({ error: 'This sign-in request has expired. Please start again from the application.' });
    }
    const user = store.findUserByEmail(email);
    if (!user || user.disabled || !(await verifyPassword(password, user.passwordHash))) {
      const f = failures.get(email) ?? { count: 0, until: 0 };
      f.count += 1;
      if (f.count >= 5) {
        f.until = Date.now() + 60_000;
        f.count = 0;
      }
      failures.set(email, f);
      log.warn({ email }, 'failed sign-in');
      return res.status(401).json({ error: 'Invalid e-mail address or password.' });
    }
    failures.delete(email);

    const client = await provider.Client.find(String(details.params.client_id));
    const meta = client as unknown as { cw_kind?: 'agent' | 'admin' | 'custom'; cw_agent_id?: string; clientName?: string } | undefined;
    const roles = rolesForClient(user, meta ? { kind: meta.cw_kind ?? 'custom', agentId: meta.cw_agent_id } : undefined);
    if (meta?.cw_kind === 'agent' && !roles.includes(AGENT_ROLES.user)) {
      return res.status(403).json({ error: `You do not have access to ${meta.clientName ?? 'this agent'}. Ask an administrator to grant you access.` });
    }
    if (meta?.cw_kind === 'admin' && !roles.includes(PLATFORM_ROLES.admin)) {
      return res.status(403).json({ error: 'The admin console requires the Platform.Admin role.' });
    }
    await store.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
    log.info({ email, client: details.params.client_id }, 'signed in');
    const redirectTo = await provider.interactionResult(req, res, { login: { accountId: user.id, remember: true } }, { mergeWithLastSubmission: false });
    res.json({ redirectTo });
  });

  r.post('/interaction/:uid/abort', async (req, res) => {
    try {
      const redirectTo = await provider.interactionResult(req, res, { error: 'access_denied', error_description: 'The user cancelled the sign-in.' }, { mergeWithLastSubmission: false });
      res.json({ redirectTo });
    } catch {
      res.status(410).json({ error: 'expired' });
    }
  });

  return r;
}
