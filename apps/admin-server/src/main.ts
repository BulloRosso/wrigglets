import { MailService } from './mail.js';
import { LiteLLMService } from './litellm.js';
import { SecretStore } from '@cw/secrets';
import { AgentService } from './agents.js';
import { AvatarService } from './avatars.js';
import { GatewayConfigService } from './gateway.js';
import { KillSwitchService } from './killswitch.js';
import { SafetyRuleEngine } from './safety.js';
import { SecurityGuardService } from './security.js';
import { SignalsControlService } from './signals.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIQUID_ID, liquidBootstrap, liquidManifest, liquidOverlay, ontologyCall } from './extensions/liquid.js';
import { LiquidPolicyService } from './extensions/liquidPolicy.js';
import { DockerExtensionRuntime } from './extensions/runtime.js';
import { ExtensionService, vaultSecretRef } from './extensions/service.js';
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
import { BUSINESS_NAMESPACE, BUSINESS_SEARCH_ATTRIBUTES } from '@cw/business-workflows';
import { LiquidProcesses } from './extensions/liquidProcesses.js';
import { ConfigRepoService, type Validators } from './liquid/configRepo.js';
import { DraftStore } from './liquid/drafts.js';
import { storeTargets } from './liquid/targets.js';
import { readTree } from './liquid/seed.js';
import { PlaybookService } from './liquid/playbooks.js';

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
  const agents = new AgentService(config, registry, runtime, oauth, temporal, ai, SecretStore.fromEnv());
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
          ? [{ name: 'demo', description: 'Demo company systems (supplier directory, FX rates)', url: config.DEMO_UPSTREAM_URL, headers: { Authorization: { secretRef: 'mcp-demo-authorization' } }, enabled: true, auth: 'static' as const, oboFallback: 'deny' as const, policy: 'none' as const }]
          : []),
        ...(config.WEB_UPSTREAM_URL
          ? [{ name: 'web', description: 'Internet access: web search and reading public pages (ADR-0031)', url: config.WEB_UPSTREAM_URL, headers: { Authorization: { secretRef: 'mcp-web-authorization' } }, enabled: true, auth: 'static' as const, oboFallback: 'deny' as const, policy: 'none' as const }]
          : []),
        ...(config.WIKI_UPSTREAM_URL
          ? [{ name: 'wiki', description: 'Central company wiki, governed by people: agents read, search and propose edits (ADR-0035)', url: config.WIKI_UPSTREAM_URL, headers: { Authorization: { secretRef: 'mcp-wiki-authorization' } }, enabled: true, auth: 'static' as const, oboFallback: 'deny' as const, policy: 'none' as const }]
          : []),
        ...(config.SIGNALS_HUB_URL && config.MCP_SIGNALS_TOKEN
          ? [{ name: 'signals', description: 'Signals: report observations and list or resolve the open expectations of this agent (ADR-0037)', url: `${config.SIGNALS_HUB_URL.replace(/\/$/, '')}/mcp`, headers: { Authorization: { secretRef: 'mcp-signals-authorization' } }, enabled: true, auth: 'static' as const, oboFallback: 'deny' as const, policy: 'none' as const }]
          : []),
        ...(config.REDTEAM_UPSTREAM_URL
          ? [{ name: 'redteam', description: 'Red-team mock: CRM, tickets with prompt injections and a recording mail tool (no authentication)', url: config.REDTEAM_UPSTREAM_URL, headers: {}, enabled: true, auth: 'static' as const, oboFallback: 'deny' as const, policy: 'none' as const }]
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
  if (secrets && config.SIGNALS_HUB_URL && config.MCP_SIGNALS_TOKEN && !(await secrets.exists('mcp-signals-authorization').catch(() => true))) {
    await secrets.set('mcp-signals-authorization', `Bearer ${config.MCP_SIGNALS_TOKEN}`).catch((err) => logger.warn({ err: String(err) }, 'could not seed signals secret'));
  }
  if (secrets && config.MCP_WIKI_TOKEN && !(await secrets.exists('mcp-wiki-authorization').catch(() => true))) {
    await secrets.set('mcp-wiki-authorization', `Bearer ${config.MCP_WIKI_TOKEN}`).catch((err) => logger.warn({ err: String(err) }, 'could not seed wiki secret'));
  }
  killSwitch.onChange = () => void gateway.push();
  const safety = new SafetyRuleEngine(config.DATA_DIR, registry, runtime, temporal, gateway, killSwitch);
  await safety.load();
  safety.start();
  const guard = new SecurityGuardService(config.DATA_DIR, registry, killSwitch, audit);
  await guard.load();
  agents.extraAiModels = () => (guard.getConfig().model ? [guard.getConfig().model] : []);
  const signals = new SignalsControlService(config.DATA_DIR, registry, runtime, killSwitch, audit);
  await signals.load();
  // Optional extensions installed from the admin console (ADR-0039)
  const extensions = new ExtensionService(config.DATA_DIR, config.RUNTIME === 'docker' ? new DockerExtensionRuntime(config.DOCKER_SOCKET, config.DOCKER_NETWORK) : undefined, { gateway, secretStore: secrets, audit });
  // Liquid Enterprise policy as code (ADR-0044): overlays + OPA bundle; the gateway gets OPA's address while installed
  const here = path.dirname(fileURLToPath(import.meta.url));
  const policyDir = [config.LIQUID_POLICY_DIR, path.resolve(here, '../../../policies/liquid')].find((p) => !!p && existsSync(p)) ?? config.LIQUID_POLICY_DIR;
  const ontologyDir = [config.LIQUID_ONTOLOGY_DIR, path.resolve(here, '../../../ontology')].find((p) => !!p && existsSync(p)) ?? config.LIQUID_ONTOLOGY_DIR;
  const liquidCtx = { url: (s: string) => extensions.url(LIQUID_ID, s), secret: (n: string) => extensions.secret(LIQUID_ID, n) ?? '' };
  const liquidPolicy = new LiquidPolicyService(config.DATA_DIR, policyDir, () => ontologyCall(liquidCtx, 'GET', '/internal/opa/data'), () => extensions.secret(LIQUID_ID, 'opa_query_token'));
  await liquidPolicy.load();
  // Config repository (ADR-0046): desired state in Git, outside /data/admin; reconciled into the stores while installed
  const compilerCall = async <T>(p: string, body: unknown): Promise<T> => {
    const res = await fetch(`${extensions.url(LIQUID_ID, 'ontology-compiler')}${p}`, { method: 'POST', headers: { authorization: `Bearer ${extensions.secret(LIQUID_ID, 'compiler_token') ?? ''}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`ontology compiler ${p}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const validators: Validators = { compileOntology: (files) => compilerCall('/compile', { files }), checkRego: (files) => compilerCall('/check-rego', { files }) };
  const configRepo = new ConfigRepoService(
    path.join(config.DATA_DIR, 'liquid'),
    storeTargets({
      gateway,
      safety,
      agents: { list: () => registry.list(), create: (b, who) => agents.create(b, who), update: (id, p) => agents.update(id, p), setEntra: (id, e) => agents.setEntra(id, e) },
      policy: liquidPolicy,
      secrets: () => [...registry.list().flatMap((a) => Object.values(registry.get(a.agentId)?.secrets ?? {}).filter((v): v is string => typeof v === 'string')), ...extensions.secretValues(LIQUID_ID), config.GATEWAY_TOKEN].filter(Boolean),
    }),
    validators,
    async () => JSON.stringify(await ontologyCall(liquidCtx, 'GET', '/internal/opa/data')),
  );
  await configRepo.load();
  liquidPolicy.policySource = async () => (extensions.isInstalled(LIQUID_ID) ? configRepo.appliedFiles('policies/liquid/') : undefined);
  const playbooksDir = [config.LIQUID_PLAYBOOKS_DIR, path.resolve(here, '../../../playbooks')].find((p) => !!p && existsSync(p)) ?? config.LIQUID_PLAYBOOKS_DIR;
  const seedConfig = async () => ({ ...(await readTree(ontologyDir, 'ontology/')), ...(await readTree(policyDir, 'policies/liquid/')), ...(await readTree(playbooksDir, 'playbooks/')) });
  // business workflows (ADR-0045): the namespace step needs the Temporal connection of this process
  extensions.register(
    liquidManifest,
    {
      ...liquidBootstrap,
      'business-namespace': async (ctx) => {
        await temporal.ensureNamespace(BUSINESS_NAMESPACE, BUSINESS_SEARCH_ATTRIBUTES);
        ctx.log(`Temporal namespace ${BUSINESS_NAMESPACE} ready`);
      },
      'config-repo': async (ctx) => {
        const r = await configRepo.init(await seedConfig(), 'install@liquid.local');
        ctx.log(r.created ? `config repository created at ${r.head.slice(0, 12)}` : `config repository exists (main ${r.head.slice(0, 12)})`);
      },
    },
    liquidOverlay(config),
  );
  await extensions.load();
  // overlay mode runs no bootstrap steps: the business namespace and the config repository are ensured here (idempotent)
  if (config.LIQUID_OVERLAY) {
    void temporal.ensureNamespace(BUSINESS_NAMESPACE, BUSINESS_SEARCH_ATTRIBUTES).catch((err) => logger.warn({ err: String(err) }, 'could not ensure the business namespace'));
    void seedConfig()
      .then((seed) => configRepo.init(seed, 'overlay@liquid.local'))
      .catch((err) => logger.warn({ err: String(err) }, 'could not initialise the config repository'));
  }
  // owned upstreams (onto, config) are registered by the extension, not through the console: record them after each operation
  extensions.onOperationDone = (id, kind, who) => (id === LIQUID_ID ? configRepo.capture(who, `extension ${id} ${kind}`) : undefined);
  configRepo.start(60_000, () => extensions.isInstalled(LIQUID_ID) && !extensions.busy(LIQUID_ID));
  // Playbooks (ADR-0047): one sensing path, runs in the business worker, steps executed here
  const liquidProcesses = new LiquidProcesses(() => (temporal.client ? temporal.namespaceClient(BUSINESS_NAMESPACE) : undefined));
  const playbooks = new PlaybookService({
    client: () => (temporal.client ? temporal.namespaceClient(BUSINESS_NAMESPACE) : undefined),
    files: () => configRepo.appliedFiles('playbooks/'),
    ontologyIr: () => ontologyCall(liquidCtx, 'GET', '/internal/ontology'),
    gatewayTools: async () => ((await gateway.gatewayCall<Array<{ name: string }>>('/internal/tools')) ?? []).map((t) => t.name),
    runningWorkflows: async () => (await liquidProcesses.list()).running.map((r) => ({ workflowId: r.workflowId, objects: r.objects })),
    events: async (events) => void (await ontologyCall(liquidCtx, 'POST', '/internal/events', { events })),
    gateway,
    overlays: liquidPolicy,
    processes: liquidProcesses,
    killSwitch,
    capture: (who, what) => configRepo.capture(who, what),
    propose: async (p) => {
      const out = await configRepo.propose({ title: p.title, reason: p.reason, changes: p.changes, author: { kind: 'agent', id: p.author } });
      return { id: out.id, valid: out.validation.ok };
    },
    shadowReplay: (body) => ontologyCall(liquidCtx, 'POST', '/internal/shadow/replay', body),
    audit,
  });
  playbooks.start(() => extensions.isInstalled(LIQUID_ID));
  safety.onTrip = (t) => (extensions.isInstalled(LIQUID_ID) ? playbooks.sense({ kind: 'safety_metric', data: t }, 'safety-rules') : undefined);
  gateway.opaProvider = () => {
    if (!extensions.isInstalled(LIQUID_ID)) return undefined;
    const raw = extensions.secret(LIQUID_ID, 'opa_query_token');
    if (!raw) return undefined;
    return { url: 'http://opa:8181', token: secrets && !liquidOverlay(config).active ? { secretRef: vaultSecretRef(LIQUID_ID, 'opa_query_token') } : raw };
  };
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

  const app = createAdminApp({ config, registry, runtime, oauth, temporal, devServer, agents, audit, ext: { config, registry, audit, avatars, killSwitch, gateway, safety, guard, secrets, oauth, ai, spendLimit: (spec) => agents.spendLimit(spec), agents, smallModel: config.AI_GATEWAY_SMALL_MODEL, signals, extensions, liquidPolicy, liquidConfig: { repo: configRepo, drafts: new DraftStore(path.join(config.DATA_DIR, 'admin', 'liquid-drafts')), validators, audit, logger }, liquidProcesses, liquidPlaybooks: playbooks, mail: new MailService(config.DATA_DIR, config.MAIL_API_URL || undefined, config.MAIL_API_KEY || undefined) } });
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
