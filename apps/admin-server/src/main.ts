import { MailService } from './mail.js';
import { LiteLLMService } from './litellm.js';
import { SecretStore } from '@cw/secrets';
import { AgentService } from './agents.js';
import { AvatarService } from './avatars.js';
import { GatewayConfigService } from './gateway.js';
import { KillSwitchService } from './killswitch.js';
import { SafetyRuleEngine } from './safety.js';
import { createAdminApp } from './api.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { OAuthAdmin } from './oauthAdmin.js';
import { AdminAudit, AgentRegistry } from './registry.js';
import { AzureAppServiceRuntime } from './runtime/azure.js';
import { DockerRuntime } from './runtime/docker.js';
import type { AgentRuntime } from './runtime/types.js';
import { TemporalDevServer } from './temporal/devServer.js';
import { TemporalPlatform } from './temporal/platform.js';

/**
 * Control plane process of the "temporal" container:
 *   1. supervise the Temporal dev server (gRPC :7233, Web UI :8233)
 *   2. bootstrap the namespace and search attributes
 *   3. serve the admin UI/API (:8080) that provisions and monitors agent containers and
 *      administers users/clients of the OAuth server
 */
async function main() {
  const config = loadConfig();

  let devServer: TemporalDevServer | undefined;
  if (config.TEMPORAL_MODE === 'embedded') {
    devServer = new TemporalDevServer(config);
    await devServer.start();
  }
  const temporal = new TemporalPlatform(config);
  await temporal.connect();
  devServer?.markUp();
  await temporal.bootstrap();
  logger.info({ address: config.TEMPORAL_ADDRESS, namespace: config.TEMPORAL_NAMESPACE, version: temporal.version }, 'Temporal ready');

  const registry = new AgentRegistry(config.DATA_DIR);
  await registry.load();
  const runtime: AgentRuntime = config.RUNTIME === 'docker' ? new DockerRuntime(config) : new AzureAppServiceRuntime();
  const oauth = new OAuthAdmin(config.oauthInternal, config.OAUTH_ADMIN_TOKEN);
  const ai = new LiteLLMService({
    url: config.LITELLM_URL,
    publicUrl: config.LITELLM_PUBLIC_URL,
    masterKey: config.LITELLM_MASTER_KEY || undefined,
    openaiKeyPresent: !!config.OPENAI_API_KEY,
    defaultModel: config.AI_GATEWAY_MODEL,
  });
  const agents = new AgentService(config, registry, runtime, oauth, temporal, ai);
  const audit = new AdminAudit(config.DATA_DIR);

  // Safety: kill switch, MCP gateway configuration, rules; secrets in Key Vault; portraits
  const secrets = SecretStore.fromEnv();
  const killSwitch = new KillSwitchService(config.DATA_DIR, registry, temporal, runtime, audit);
  await killSwitch.load();
  const gateway = new GatewayConfigService(config.DATA_DIR, registry, runtime, killSwitch, config.MCP_GATEWAY_URL, config.GATEWAY_TOKEN);
  await gateway.load(
    {
      upstreams: [
        ...(config.DEMO_UPSTREAM_URL
          ? [{ name: 'demo', description: 'Demo company systems (supplier directory, FX rates)', url: config.DEMO_UPSTREAM_URL, headers: { Authorization: { secretRef: 'mcp-demo-authorization' } }, enabled: true }]
          : []),
        ...(config.WEB_UPSTREAM_URL
          ? [{ name: 'web', description: 'Internet access: web search and reading public pages (ADR-0031)', url: config.WEB_UPSTREAM_URL, headers: { Authorization: { secretRef: 'mcp-web-authorization' } }, enabled: true }]
          : []),
      ],
    },
  );
  // Demo upstream credential lives in Key Vault (the gateway resolves it by reference).
  if (secrets && config.MCP_DEMO_TOKEN && !(await secrets.exists('mcp-demo-authorization').catch(() => true))) {
    await secrets.set('mcp-demo-authorization', `Bearer ${config.MCP_DEMO_TOKEN}`).catch((err) => logger.warn({ err: String(err) }, 'could not seed demo secret'));
  }
  if (secrets && config.MCP_WEB_TOKEN && !(await secrets.exists('mcp-web-authorization').catch(() => true))) {
    await secrets.set('mcp-web-authorization', `Bearer ${config.MCP_WEB_TOKEN}`).catch((err) => logger.warn({ err: String(err) }, 'could not seed web secret'));
  }
  killSwitch.onChange = () => void gateway.push();
  const safety = new SafetyRuleEngine(config.DATA_DIR, registry, runtime, temporal, gateway, killSwitch);
  await safety.load();
  safety.start();
  const avatars = new AvatarService({
    dataDir: config.DATA_DIR,
    defaultReference: config.AVATAR_DEFAULT_REFERENCE,
    apiKey: config.OPENAI_API_KEY || undefined,
    model: config.AVATAR_IMAGE_MODEL,
    quality: config.AVATAR_QUALITY,
  });
  // Re-apply the kill switch to agents whose lock manager does not know the current level (e.g. after a restart).
  setInterval(() => void killSwitch.reconcile().catch((err) => logger.warn({ err: String(err) }, 'kill switch reconcile failed')), 60_000).unref();
  void killSwitch.reconcile().catch(() => undefined);
  logger.info({ keyVault: !!secrets, portraits: avatars.enabled, model: config.AVATAR_IMAGE_MODEL }, 'safety services ready');

  const app = createAdminApp({ config, registry, runtime, oauth, temporal, devServer, agents, audit, ext: { config, registry, audit, avatars, killSwitch, gateway, safety, secrets, oauth, ai, spendLimit: (spec) => agents.spendLimit(spec), agents, smallModel: config.AI_GATEWAY_SMALL_MODEL, mail: new MailService(config.DATA_DIR, config.MAIL_API_URL || undefined, config.MAIL_API_KEY || undefined) } });
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, url: config.publicUrl }, 'admin console listening'));

  // Make sure every registered agent has its OIDC client (e.g. after the OAuth data volume was reset).
  void (async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await oauth.healthy()) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    for (const spec of registry.list()) {
      const entry = registry.get(spec.agentId)!;
      await oauth
        .upsertClient({
          clientId: agents.clientId(spec.agentId),
          name: spec.displayName,
          kind: 'agent',
          agentId: spec.agentId,
          clientSecret: entry.secrets.oidcClientSecret,
          redirectUris: [`${agents.publicUrl(spec)}/auth/callback`],
          postLogoutRedirectUris: [`${agents.publicUrl(spec)}/`],
        })
        .catch((err) => logger.warn({ agentId: spec.agentId, err: String(err) }, 'could not reconcile OIDC client'));
    }
  })();

  // Agents created before LiteLLM (ADR-0029) have no virtual key and may use a model LiteLLM does not know (e.g. the
  // removed mock model): switch them to the default model, provision a key and redeploy them once LiteLLM is up.
  void (async () => {
    let status = await ai.status(true);
    for (let attempt = 0; attempt < 60 && !status.reachable; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      status = await ai.status(true);
    }
    if (!status.reachable) return;
    const known = new Set(status.models.map((m) => m.name));
    const outdated = registry.list().filter((s) => !registry.get(s.agentId)?.secrets.aiKey || !known.has(s.model));
    for (const spec of outdated) {
      try {
        if (!known.has(spec.model)) {
          const entry = registry.get(spec.agentId)!;
          await registry.put({ ...entry.spec, model: config.AI_GATEWAY_MODEL, updatedAt: new Date().toISOString() }, entry.secrets);
          logger.info({ agentId: spec.agentId, from: spec.model, to: config.AI_GATEWAY_MODEL }, 'agent switched to a configured model');
        }
        await agents.redeploy(spec.agentId);
        logger.info({ agentId: spec.agentId }, 'agent migrated to its LiteLLM virtual key');
      } catch (err) {
        logger.warn({ agentId: spec.agentId, err: String(err) }, 'could not migrate agent to LiteLLM');
      }
    }
  })();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await devServer?.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'admin server failed to start');
  process.exit(1);
});
