import type { AgentSpec, AgentSummary, CreateAgentBody, HealthReport, UpdateAgentBody } from '@cw/shared';
import type { Config } from './config.js';
import { logger } from './logger.js';
import type { OAuthAdmin } from './oauthAdmin.js';
import type { LiteLLMService } from './litellm.js';
import type { AgentRegistry, AgentSecrets } from './registry.js';
import type { AgentRuntime } from './runtime/types.js';
import type { TemporalPlatform } from './temporal/platform.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Agent lifecycle: desired state (registry) → identity (OIDC client) → runtime (container).
 * The same flow will drive App Service instances on Azure.
 */
export class AgentService {
  constructor(
    private readonly config: Config,
    private readonly registry: AgentRegistry,
    private readonly runtime: AgentRuntime,
    private readonly oauth: OAuthAdmin,
    private readonly temporal: TemporalPlatform,
    private readonly ai?: LiteLLMService,
  ) {}

  spendLimit(spec: AgentSpec) {
    return spec.spendLimitUsd ?? this.config.AGENT_SPEND_LIMIT_USD;
  }

  /** Models the agent's key may use: its model and the small model (titles, summaries). */
  aiModels(spec: AgentSpec) {
    return [...new Set([spec.model, this.config.AI_GATEWAY_SMALL_MODEL])];
  }

  /** Replaces the agent's virtual key: new key with the same budget and models, redeploy, then delete the old key. */
  async rotateAiKey(agentId: string) {
    const entry = this.registry.get(agentId);
    if (!entry) throw new HttpError(404, 'agent not found');
    if (!this.ai) throw new HttpError(409, 'No AI gateway configured');
    const old = entry.secrets.aiKey;
    const key = await this.ai.rotateKey(entry.spec, this.spendLimit(entry.spec), this.aiModels(entry.spec));
    const secrets = { ...entry.secrets, aiKey: key };
    await this.registry.put(entry.spec, secrets);
    await this.runtime.deploy(entry.spec, this.env(entry.spec, secrets), { start: true });
    await this.ai.deleteKey(old);
    return key;
  }

  /** Creates or updates the agent's LiteLLM virtual key (budget = spend limit) and stores it with the secrets. */
  async ensureAiKey(spec: AgentSpec, secrets: AgentSecrets): Promise<AgentSecrets> {
    if (!this.ai) return secrets;
    try {
      const key = await this.ai.ensureKey(spec, secrets.aiKey, this.spendLimit(spec), this.aiModels(spec));
      if (key === secrets.aiKey) return secrets;
      const next = { ...secrets, aiKey: key };
      await this.registry.put(spec, next);
      return next;
    } catch (err) {
      // LiteLLM down: deploy anyway; the agent shows "no AI model" until the next redeploy
      logger.warn({ agentId: spec.agentId, err: String(err) }, 'could not provision the LiteLLM key');
      return secrets;
    }
  }

  publicUrl(spec: AgentSpec) {
    return `http://${this.config.AGENT_PUBLIC_HOST}:${spec.hostPort}`;
  }

  clientId(agentId: string) {
    return `agent-${agentId}`;
  }

  /** Environment of the agent container (spec §4; secrets would be Key Vault references on Azure). */
  env(spec: AgentSpec, secrets: AgentSecrets): Record<string, string> {
    const c = this.config;
    return {
      NODE_ENV: 'production',
      LOG_LEVEL: c.AGENT_LOG_LEVEL,
      PORT: '8080',
      PUBLIC_BASE_URL: this.publicUrl(spec),
      AGENT_ID: spec.agentId,
      AGENT_DISPLAY_NAME: spec.displayName,
      AGENT_GIT_EMAIL: spec.gitEmail,
      TEMPORAL_ADDRESS: c.AGENT_TEMPORAL_ADDRESS,
      TEMPORAL_NAMESPACE: c.TEMPORAL_NAMESPACE,
      TEMPORAL_UI_URL: c.TEMPORAL_UI_PUBLIC_URL,
      PAYLOAD_CODEC_KEYS: c.PAYLOAD_CODEC_KEYS,
      CODEC_CORS_ORIGINS: c.TEMPORAL_UI_PUBLIC_URL,
      // AI model through LiteLLM with the agent's own virtual key (ADR-0029)
      AI_GATEWAY_BASE_URL: `${c.LITELLM_URL}/v1`,
      AI_GATEWAY_API_KEY: secrets.aiKey ?? 'not-provisioned',
      AI_GATEWAY_MODEL: spec.model,
      AI_GATEWAY_SMALL_MODEL: c.AI_GATEWAY_SMALL_MODEL,
      APPROVAL_REMINDER_AFTER: c.APPROVAL_REMINDER_AFTER,
      APPROVAL_EXPIRE_AFTER: c.APPROVAL_EXPIRE_AFTER,
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: c.OAUTH_ISSUER,
      OIDC_INTERNAL_URL: c.AGENT_OIDC_INTERNAL_URL,
      OIDC_CLIENT_ID: this.clientId(spec.agentId),
      OIDC_CLIENT_SECRET: secrets.oidcClientSecret,
      SESSION_SECRET: secrets.sessionSecret,
      AGENT_DESCRIPTION: spec.description || spec.displayName,
      // tools and A2A only through the MCP gateway (ADR-0021/0023)
      MCP_GATEWAY_URL: `${c.MCP_GATEWAY_URL}/agents/${spec.agentId}/mcp`,
      MCP_GATEWAY_BASE_URL: c.MCP_GATEWAY_URL,
      MCP_GATEWAY_TOKEN: secrets.internalToken,
      A2A_GATEWAY_TOKEN: c.GATEWAY_TOKEN,
      CONTROL_PLANE_URL: c.AGENT_CONTROL_PLANE_URL,
      CONTROL_PLANE_TOKEN: secrets.internalToken,
    };
  }

  private async registerClient(spec: AgentSpec, secrets: AgentSecrets) {
    const url = this.publicUrl(spec);
    await this.oauth.upsertClient({
      clientId: this.clientId(spec.agentId),
      name: spec.displayName,
      kind: 'agent',
      agentId: spec.agentId,
      clientSecret: secrets.oidcClientSecret,
      redirectUris: [`${url}/auth/callback`],
      postLogoutRedirectUris: [`${url}/`],
    });
  }

  private async freePort(): Promise<number> {
    const used = new Set([...(await this.runtime.usedPorts()), ...this.registry.list().map((a) => a.hostPort)]);
    for (let p = this.config.portRange.from; p <= this.config.portRange.to; p++) if (!used.has(p)) return p;
    throw new HttpError(409, 'No free host port left in AGENT_PORT_RANGE');
  }

  async create(body: CreateAgentBody, by: string) {
    if (this.registry.get(body.agentId)) throw new HttpError(409, `Agent "${body.agentId}" already exists`);
    const now = new Date().toISOString();
    const spec: AgentSpec = {
      agentId: body.agentId,
      displayName: body.displayName,
      description: body.description,
      gitEmail: body.gitEmail ?? `agent-${body.agentId}@coworking.local`,
      image: body.image ?? this.config.AGENT_IMAGE,
      hostPort: body.hostPort ?? (await this.freePort()),
      model: body.model ?? this.config.AI_GATEWAY_MODEL,
      spendLimitUsd: body.spendLimitUsd ?? this.config.AGENT_SPEND_LIMIT_USD,
      resources: { cpus: body.cpus, memoryMb: body.memoryMb },
      createdAt: now,
      createdBy: by,
      updatedAt: now,
    };
    const secrets = await this.ensureAiKey(spec, (await this.registry.put(spec)).secrets);
    await this.registerClient(spec, secrets);
    const runtime = await this.runtime.deploy(spec, this.env(spec, secrets), { start: body.start });
    logger.info({ agentId: spec.agentId, port: spec.hostPort, image: spec.image }, 'agent deployed');
    return { spec, runtime };
  }

  async update(agentId: string, patch: UpdateAgentBody) {
    const entry = this.registry.get(agentId);
    if (!entry) throw new HttpError(404, 'agent not found');
    const spec: AgentSpec = {
      ...entry.spec,
      displayName: patch.displayName ?? entry.spec.displayName,
      description: patch.description ?? entry.spec.description,
      image: patch.image ?? entry.spec.image,
      model: patch.model ?? entry.spec.model,
      spendLimitUsd: patch.spendLimitUsd ?? entry.spec.spendLimitUsd,
      resources: { cpus: patch.cpus ?? entry.spec.resources.cpus, memoryMb: patch.memoryMb ?? entry.spec.resources.memoryMb },
      avatarPrompt: patch.avatarPrompt ?? entry.spec.avatarPrompt,
      peers: patch.peers ? [...new Set(patch.peers.filter((p) => p !== agentId))].sort() : entry.spec.peers,
      updatedAt: new Date().toISOString(),
    };
    if (spec.peers?.some((p) => !this.registry.get(p))) throw new HttpError(400, 'Unknown agent in discovery set');
    await this.registry.put(spec, entry.secrets);
    // a new spend limit only changes the LiteLLM key budget
    const secrets =
      patch.spendLimitUsd !== undefined || patch.model !== undefined || !entry.secrets.aiKey ? await this.ensureAiKey(spec, entry.secrets) : entry.secrets;
    // Portrait prompt, discovery set and spend limit do not need a new container.
    const runtimeFields: Array<keyof UpdateAgentBody> = ['displayName', 'description', 'image', 'model', 'cpus', 'memoryMb'];
    if (!runtimeFields.some((k) => patch[k] !== undefined)) return { spec, runtime: await this.runtime.inspect(agentId) };
    await this.registerClient(spec, secrets);
    // Re-create the container; the /home volume (workspace) is kept. Temporal retries in-flight steps.
    const runtime = await this.runtime.deploy(spec, this.env(spec, secrets), { start: true });
    return { spec, runtime };
  }

  /** Re-applies identity and runtime configuration (e.g. after secrets rotation or env changes). */
  async redeploy(agentId: string) {
    const entry = this.registry.get(agentId);
    if (!entry) throw new HttpError(404, 'agent not found');
    const secrets = await this.ensureAiKey(entry.spec, entry.secrets);
    await this.registerClient(entry.spec, secrets);
    return this.runtime.deploy(entry.spec, this.env(entry.spec, secrets), { start: true });
  }

  async remove(agentId: string, opts: { purgeData: boolean; removeAccess: boolean }) {
    const entry = this.registry.get(agentId);
    if (!entry) throw new HttpError(404, 'agent not found');
    await this.runtime.remove(agentId, { purgeData: opts.purgeData });
    await this.oauth.deleteClient(this.clientId(agentId), opts.removeAccess).catch((err) => logger.warn({ err: String(err) }, 'could not delete OIDC client'));
    let temporal = { schedules: 0, workflows: 0 };
    if (opts.purgeData) temporal = await this.temporal.purgeAgent(agentId, 'agent deleted by admin');
    await this.ai?.deleteKey(entry.secrets.aiKey);
    await this.registry.delete(agentId);
    return temporal;
  }

  async health(spec: AgentSpec): Promise<HealthReport | undefined> {
    try {
      const res = await fetch(`${this.runtime.internalUrl(spec.agentId)}/health`, { signal: AbortSignal.timeout(2500) });
      return (await res.json()) as HealthReport;
    } catch {
      return undefined;
    }
  }

  async summary(spec: AgentSpec, opts: { withHealth: boolean }): Promise<AgentSummary> {
    const runtime = await this.runtime.inspect(spec.agentId);
    const [health, lock, openTasks] = await Promise.all([
      opts.withHealth && runtime.state !== 'stopped' && runtime.state !== 'missing' ? this.health(spec) : Promise.resolve(undefined),
      this.temporal.agentLock(spec.agentId),
      this.temporal.count(`AgentId = '${spec.agentId}' AND WorkflowType = 'taskWorkflow' AND ExecutionStatus = 'Running'`).catch(() => undefined),
    ]);
    return { spec, runtime, url: this.publicUrl(spec), health, lock, openTasks };
  }
}
