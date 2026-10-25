import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { pino } from 'pino';
import { ALL_AGENT_ROLES, PLATFORM_ROLES } from '@cw/shared';
import { adminApi } from './adminApi.js';
import { loadConfig } from './config.js';
import { interactionRouter } from './interactions.js';
import { loadOrCreateSecrets } from './keys.js';
import { createProvider } from './provider.js';
import { Store } from './store.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'oauth-server' }, timestamp: pino.stdTimeFunctions.isoTime });

async function main() {
  const config = loadConfig();
  const store = new Store(config.DATA_DIR);
  await store.load();
  const secrets = await loadOrCreateSecrets(config.DATA_DIR);

  // Bootstrap: first platform admin + the admin console client.
  if (store.listUsers().length === 0) {
    if (!config.BOOTSTRAP_ADMIN_PASSWORD) throw new Error('BOOTSTRAP_ADMIN_PASSWORD is required on first start');
    await store.createUser({ email: config.BOOTSTRAP_ADMIN_EMAIL, name: config.BOOTSTRAP_ADMIN_NAME, password: config.BOOTSTRAP_ADMIN_PASSWORD, platformRoles: [PLATFORM_ROLES.admin] });
    log.info({ email: config.BOOTSTRAP_ADMIN_EMAIL }, 'bootstrap admin created');
    if (config.SEED_DEMO_USERS) {
      // People of the reference scenario (spec §19). Access to agents is granted in the admin UI.
      const demo: Array<[string, string, string[]]> = [
        ['anna@example.com', 'Anna Becker', ['Agent.User']],
        ['ben@example.com', 'Ben Schulz', ['Agent.User', 'Agent.Approver']],
        ['clara@example.com', 'Clara Weber', ['Agent.User']],
      ];
      for (const [email, name, roles] of demo) {
        await store.createUser({ email, name, password: config.DEMO_USER_PASSWORD, agentRoles: { '*': roles } });
      }
      log.info('demo users seeded (anna, ben, clara)');
    }
  }
  const adminBase = config.ADMIN_PUBLIC_URL.replace(/\/$/, '');
  await store.upsertClient({
    clientId: config.ADMIN_CLIENT_ID,
    clientSecret: config.ADMIN_CLIENT_SECRET,
    name: 'Admin console',
    kind: 'admin',
    redirectUris: [`${adminBase}/auth/callback`],
    postLogoutRedirectUris: [`${adminBase}/`],
  });

  const provider = createProvider(config, store, secrets);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = config.WEB_DIST_DIR ?? path.resolve(here, '../../oauth-web/dist');

  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', true);
  app.get('/health', (_req, res) => res.json({ status: 'ok', issuer: config.OAUTH_ISSUER }));
  app.use('/admin/api', adminApi(store, config.OAUTH_ADMIN_TOKEN));
  if (existsSync(webDir)) {
    app.use('/assets', express.static(path.join(webDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.get('/favicon.svg', (_req, res) => res.sendFile(path.join(webDir, 'favicon.svg')));
  }
  app.use(interactionRouter(provider, store, webDir, log));
  app.get('/', (_req, res) => res.redirect(adminBase));
  app.use(provider.callback());

  app.listen(config.PORT, () => log.info({ port: config.PORT, issuer: config.OAUTH_ISSUER, roles: ALL_AGENT_ROLES }, 'oauth server listening'));
}

main().catch((err) => {
  log.fatal({ err }, 'oauth server failed to start');
  process.exit(1);
});
