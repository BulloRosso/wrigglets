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
import { EventFeed } from './liquid/eventFeed.js';
import { Forge, ForgeError } from './liquid/forge.js';
import { ApprovalService } from './liquid/approvals.js';
import pg from 'pg';

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
  // Liquid Enterprise policy as code (ADR-0044/0049): overlays + the policy package (Rego → WASM) for gateway and core
  const here = path.dirname(fileURLToPath(import.meta.url));
  const policyDir = [config.LIQUID_POLICY_DIR, path.resolve(here, '../../../policies/liquid')].find((p) => !!p && existsSync(p)) ?? config.LIQUID_POLICY_DIR;
  const ontologyDir = [config.LIQUID_ONTOLOGY_DIR, path.resolve(here, '../../../ontology')].find((p) => !!p && existsSync(p)) ?? config.LIQUID_ONTOLOGY_DIR;
  const liquidCtx = { url: (s: string) => extensions.url(LIQUID_ID, s), secret: (n: string) => extensions.secret(LIQUID_ID, n) ?? '' };
  const liquidPolicy = new LiquidPolicyService(
    config.DATA_DIR,
    policyDir,
    () => ontologyCall(liquidCtx, 'GET', '/internal/opa/data'),
    (files) => compilerCall('/build-wasm', { files }),
    async () => ontologyCall(liquidCtx, 'GET', '/internal/policy/decisions?limit=50'),
  );
  await liquidPolicy.load();
  // Config repository (ADR-0046): desired state in Git, outside /data/admin; reconciled into the stores while installed
  const compilerCall = async <T>(p: string, body: unknown): Promise<T> => {
    const res = await fetch(`${extensions.url(LIQUID_ID, 'ontology-compiler')}${p}`, { method: 'POST', headers: { authorization: `Bearer ${extensions.secret(LIQUID_ID, 'compiler_token') ?? ''}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`ontology compiler ${p}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const validators: Validators = {
    compileOntology: (files) => compilerCall('/compile', { files }),
    checkRego: (files) => compilerCall('/check-rego', { files }),
    checkOntology: (ir) => ontologyCall(liquidCtx, 'POST', '/internal/ontology/check', { ir }),
  };
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
  // the Git host of the config repository (ADR-0049): Forgejo as an extension service
  const FORGE = { org: 'liquid', repo: 'config', bot: 'liquid-bot', reviewer: 'reviewer', team: 'reviewers' };
  const forge = new Forge({
    baseUrl: () => extensions.url(LIQUID_ID, 'forgejo'),
    publicUrl: 'http://localhost:3300',
    bot: { user: FORGE.bot, password: () => extensions.secret(LIQUID_ID, 'forgejo_bot_password') },
    owner: FORGE.org,
    repo: FORGE.repo,
    webhookSecret: () => extensions.secret(LIQUID_ID, 'forgejo_webhook_secret'),
  });
  configRepo.consoleUrl = (id) => `${config.PUBLIC_URL.replace(/\/$/, '')}/liquid/proposals/${id}`;
  if (configRepo.forgeReady) configRepo.forge = forge;
  // ontology versions (ADR-0048): a changed ontology in main is compiled and applied to the running ontology server
  configRepo.ontologyInForce = async () => (await ontologyCall<{ source?: { files?: Record<string, string> } }>(liquidCtx, 'GET', '/internal/ontology')).source?.files;
  configRepo.onOntology = async (domain, files, note) => {
    const out = await compilerCall<{ ok: boolean; ir?: unknown; errors?: Array<{ path: string; message: string }> }>('/compile', { files });
    if (!out.ok || !out.ir) throw new Error(`ontology ${domain} does not compile: ${(out.errors ?? []).map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    const r = await ontologyCall<{ applied: boolean; from?: string; to?: string; level?: string; migration?: string; reason?: string }>(liquidCtx, 'POST', '/internal/ontology/apply', { ir: out.ir, allowBreaking: true, note, by: 'reconciler' });
    if (!r.applied) return undefined;
    await gateway.push(); // agents see the new tools at once (the gateway drops its tool cache)
    return `ontology ${domain} ${r.from} → ${r.to} (${r.level}, ${r.migration})`;
  };
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
      // the Git host's database and role in the shared Liquid Postgres (one instance, a schema/role per consumer)
      'forgejo-db': async (ctx) => {
        const client = new pg.Client({ host: ctx.host('ontology-db'), port: 5432, user: 'onto', password: ctx.secret('ontology_db_password'), database: 'onto' });
        for (let i = 0; ; i++) {
          try {
            await client.connect();
            break;
          } catch (err) {
            if (i > 30) throw err;
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        try {
          const pw = ctx.secret('forgejo_db_password').replace(/'/g, "''");
          const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'forgejo'");
          await client.query(role.rows.length ? `ALTER ROLE forgejo WITH LOGIN PASSWORD '${pw}'` : `CREATE ROLE forgejo WITH LOGIN PASSWORD '${pw}'`);
          const db = await client.query("SELECT 1 FROM pg_database WHERE datname = 'forgejo'");
          if (!db.rows.length) await client.query('CREATE DATABASE forgejo OWNER forgejo');
          ctx.log('database forgejo and role ready');
        } finally {
          await client.end();
        }
      },
      'forgejo-setup': async (ctx) => {
        for (let i = 0; !(await forge.ready()); i++) {
          if (i > 60) throw new Error('the Git host did not become ready');
          await new Promise((r) => setTimeout(r, 2000));
        }
        const bot = ctx.secret('forgejo_bot_password');
        const created = await ctx.exec('forgejo', ['forgejo', 'admin', 'user', 'create', '--admin', '--username', FORGE.bot, '--email', 'bot@liquid.local', '--password', bot, '--must-change-password=false'], 'git');
        if (created.code !== 0 && !/already exists/i.test(created.output)) throw new Error(`bot account: ${created.output.trim().slice(0, 300)}`);
        await ctx.exec('forgejo', ['forgejo', 'admin', 'user', 'change-password', '--username', FORGE.bot, '--password', bot, '--must-change-password=false'], 'git');
        const ok = (p: Promise<unknown>) => p.catch((err: unknown) => (err instanceof ForgeError && (err.status === 409 || err.status === 422) ? undefined : Promise.reject(err)));
        const reviewer = { username: FORGE.reviewer, email: 'reviewer@liquid.local', full_name: 'Config reviewer', password: ctx.secret('forgejo_reviewer_password'), must_change_password: false };
        await ok(forge.api('POST', '/admin/users', reviewer));
        await forge.api('PATCH', `/admin/users/${FORGE.reviewer}`, { login_name: FORGE.reviewer, source_id: 0, password: reviewer.password, must_change_password: false });
        await ok(forge.api('POST', '/orgs', { username: FORGE.org, visibility: 'private', full_name: 'Liquid Enterprise' }));
        const teams = await forge.api<Array<{ id: number; name: string }>>('GET', `/orgs/${FORGE.org}/teams`);
        const team = teams.find((t) => t.name === FORGE.team) ?? (await forge.api<{ id: number }>('POST', `/orgs/${FORGE.org}/teams`, { name: FORGE.team, permission: 'write', includes_all_repositories: true, units: ['repo.code', 'repo.pulls', 'repo.issues'] }));
        await forge.api('PUT', `/teams/${team.id}/members/${FORGE.reviewer}`);
        await ok(forge.api('POST', `/orgs/${FORGE.org}/repos`, { name: FORGE.repo, private: true, default_branch: 'main', auto_init: false, description: 'Desired state of the platform (Liquid Enterprise)' }));
        configRepo.forge = forge;
        const s = await configRepo.sync();
        ctx.log(`repository ${FORGE.org}/${FORGE.repo}: ${s.action}`);
        await configRepo.writeCodeowners(FORGE.org, FORGE.team);
        const protection = { rule_name: 'main', branch_name: 'main', enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [FORGE.bot], required_approvals: 1, enable_status_check: true, status_check_contexts: ['liquid/validate'], block_on_rejected_reviews: true, dismiss_stale_approvals: true, block_on_outdated_branch: false };
        const existing = await forge.api<Array<{ rule_name?: string; branch_name?: string }>>('GET', `${forge.repoPath}/branch_protections`);
        if (existing.some((b) => (b.rule_name ?? b.branch_name) === 'main')) await forge.api('PATCH', `${forge.repoPath}/branch_protections/main`, protection);
        else await forge.api('POST', `${forge.repoPath}/branch_protections`, protection);
        const hookUrl = 'http://temporal:8080/internal/liquid/forgejo';
        const hooks = await forge.api<Array<{ id: number; config: { url: string } }>>('GET', `${forge.repoPath}/hooks`);
        for (const h of hooks.filter((x) => x.config.url === hookUrl)) await forge.api('DELETE', `${forge.repoPath}/hooks/${h.id}`);
        await forge.api('POST', `${forge.repoPath}/hooks`, { type: 'forgejo', active: true, events: ['push', 'pull_request'], config: { url: hookUrl, content_type: 'json', secret: ctx.secret('forgejo_webhook_secret') } });
        await configRepo.markForgeReady();
        ctx.log(`Git host ready: http://localhost:3300/${FORGE.org}/${FORGE.repo} (reviewer account "${FORGE.reviewer}")`);
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
  extensions.onOperationDone = (id, kind, who) =>
    id === LIQUID_ID && kind !== 'uninstall'
      ? configRepo.capture(who, `extension ${id} ${kind}`).then(() => configRepo.reconcile('extension operation')) // a fresh core gets main's ontology at once
      : undefined;
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
    editing: async (fn) => {
      configRepo.beginEdit();
      try {
        return await fn();
      } finally {
        configRepo.endEdit();
      }
    },
    propose: async (p) => {
      const out = await configRepo.propose({ title: p.title, reason: p.reason, changes: p.changes, author: { kind: 'agent', id: p.author } });
      return { id: out.id, valid: out.validation.ok };
    },
    shadowReplay: (body) => ontologyCall(liquidCtx, 'POST', '/internal/shadow/replay', body),
    audit,
  });
  playbooks.start(() => extensions.isInstalled(LIQUID_ID));
  // event log as the one source of truth (ADR-0049): audit trails and reconcile runs become events
  const appendEvents = async (events: unknown[]) => void (await ontologyCall(liquidCtx, 'POST', '/internal/events', { events }));
  configRepo.onReconciled = (r) => void appendEvents([{ type: 'ConfigReconciled', objectType: 'ConfigRepository', objectId: r.head.slice(0, 12), actorUser: 'reconciler', payload: r }]).catch(() => undefined);
  const eventFeed = new EventFeed(config.DATA_DIR, {
    adminAudit: () => audit.list(500),
    gatewayAudit: async () => (await gateway.gatewayCall<Array<Record<string, unknown> & { at: string; agentId: string; tool: string; outcome: string }>>('/internal/audit?limit=1000')) ?? undefined,
    agents: () => registry.list().map((a) => a.agentId),
    agentAudit: async (agentId, since) => {
      const entry = registry.get(agentId);
      if (!entry) return undefined;
      const res = await fetch(`${runtime.internalUrl(agentId)}/internal/app-audit?since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${entry.secrets.internalToken}` }, signal: AbortSignal.timeout(5000) });
      return res.ok ? ((await res.json()) as Array<{ at: string; by: string; action: string; target: string; details?: Record<string, unknown> }>) : undefined;
    },
    append: appendEvents,
    enabled: () => extensions.isInstalled(LIQUID_ID) && !extensions.busy(LIQUID_ID),
  });
  await eventFeed.load();
  eventFeed.start();
  // one approval mechanism (ADR-0049): ApprovalWorkflows + pull requests + plan approvals in one inbox, mailed
  const mailService = new MailService(config.DATA_DIR, config.MAIL_API_URL || undefined, config.MAIL_API_KEY || undefined);
  const wikiAdmin = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${config.WIKI_URL}/admin${p}`, { method, headers: { authorization: `Bearer ${config.WIKI_ADMIN_TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`wiki ${method} ${p}: HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  const approvals = new ApprovalService({
    client: () => (temporal.client ? temporal.namespaceClient(BUSINESS_NAMESPACE) : undefined),
    publicUrl: config.PUBLIC_URL.replace(/\/$/, ''),
    wiki: config.WIKI_URL && config.WIKI_ADMIN_TOKEN ? { list: async () => (await wikiAdmin('GET', '/proposals?status=pending')) as never, decide: (id, decision, who, comment) => wikiAdmin('POST', `/proposals/${encodeURIComponent(id)}/decide`, { decision, comment, by: who }) } : undefined,
    configProposals: () => configRepo.list(),
    plans: async () =>
      (await temporal.tasks("ExecutionStatus = 'Running' AND TaskStatus = 'awaiting_approval'", 50)).map((t) => ({ taskId: t.taskId, agentId: t.agentId, title: `Plan of ${t.agentId}: ${t.title}`, requestedBy: t.requestedBy, createdAt: t.startTime, link: `${config.PUBLIC_URL.replace(/\/$/, '')}/agents/${t.agentId}` })),
    approvers: async () => (await oauth.users()).filter((u) => !u.disabled && u.platformRoles.includes('Platform.Admin')).map((u) => u.email),
    mail: async (m) => void (await mailService.send({ agentId: 'liquid', agentName: 'Liquid Enterprise', kind: 'approval_requested', to: m.to, subject: m.subject, html: m.html })),
    dataDir: config.DATA_DIR,
    log: logger,
  });
  await approvals.load();
  approvals.start(() => extensions.isInstalled(LIQUID_ID) && !!temporal.client);
  // one sensing path (ADR-0049): Signals observations are events, playbooks subscribe (trigger kind signal)
  signals.onObservation = (o) => (extensions.isInstalled(LIQUID_ID) ? playbooks.sense({ kind: 'signal', data: o }, 'signals-hub') : undefined);
  safety.onTrip = (t) => (extensions.isInstalled(LIQUID_ID) ? playbooks.sense({ kind: 'safety_metric', data: t }, 'safety-rules') : undefined);
  gateway.policyProvider = () => (extensions.isInstalled(LIQUID_ID) ? { url: 'http://temporal:8080/internal/liquid/policy' } : undefined);
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

  const app = createAdminApp({ config, registry, runtime, oauth, temporal, devServer, agents, audit, ext: { config, registry, audit, avatars, killSwitch, gateway, safety, guard, secrets, oauth, ai, spendLimit: (spec) => agents.spendLimit(spec), agents, smallModel: config.AI_GATEWAY_SMALL_MODEL, signals, extensions, liquidPolicy, liquidConfig: { repo: configRepo, drafts: new DraftStore(path.join(config.DATA_DIR, 'admin', 'liquid-drafts')), validators, audit, logger }, liquidProcesses, liquidPlaybooks: playbooks, liquidApprovals: approvals, mail: new MailService(config.DATA_DIR, config.MAIL_API_URL || undefined, config.MAIL_API_KEY || undefined) } });
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
