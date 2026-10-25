import { z } from 'zod';
import type { AgentStatus, HealthReport } from './agent.js';
import type { EffectiveKillSwitch } from './killswitch.js';
import { AGENT_ID_PATTERN } from './ids.js';

/* ------------------------------------------------------------------ agents */

/** Desired configuration of one agent instance (one container / one App Service). */
export interface AgentSpec {
  agentId: string;
  displayName: string;
  description?: string;
  gitEmail: string;
  /** Container image reference, e.g. `coworking/agent:local` or `<acr>.azurecr.io/coworking/agent:<sha>`. */
  image: string;
  /** Host port the agent UI is published on (local Docker runtime only). */
  hostPort: number;
  /** Model name as configured in LiteLLM (infra/litellm/config.yaml), e.g. `gpt-5.4-mini`. */
  model: string;
  /** Spend limit of the agent's LiteLLM virtual key in USD per rolling 30 days (ADR-0029). */
  spendLimitUsd?: number;
  resources: { cpus: number; memoryMb: number };
  /** Prompt describing the agent's portrait (see AvatarService). */
  avatarPrompt?: string;
  /**
   * A2A discovery set: agent ids this agent may discover and delegate to (one-directional).
   * Default empty = isolated (ADR-0023).
   */
  peers?: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export type RuntimeState = 'running' | 'starting' | 'stopped' | 'restarting' | 'failed' | 'missing';

export interface AgentRuntimeInfo {
  state: RuntimeState;
  detail: string;
  containerId?: string;
  image?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  restartCount?: number;
}

export interface AgentStats {
  at: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
}

export interface AgentSummary {
  spec: AgentSpec;
  runtime: AgentRuntimeInfo;
  url: string;
  health?: HealthReport;
  lock?: AgentStatus;
  openTasks?: number;
  killSwitch?: EffectiveKillSwitch;
  /** Timestamp of the portrait set (for cache busting); undefined = no portrait yet. */
  avatarVersion?: string;
  /** Spend of the last 30 days (only when requested). */
  spend?: import('./ai.js').AgentSpend;
}

export const createAgentBody = z.object({
  agentId: z.string().regex(AGENT_ID_PATTERN, 'lower-case letters, digits and dashes (3–32 chars)'),
  displayName: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional(),
  gitEmail: z.string().email().optional(),
  image: z.string().trim().min(1).max(300).optional(),
  model: z.string().trim().min(3).max(120).optional(),
  spendLimitUsd: z.number().min(0.5).max(10_000).optional(),
  hostPort: z.number().int().min(1024).max(65535).optional(),
  cpus: z.number().min(0.25).max(8).default(1),
  memoryMb: z.number().int().min(512).max(16_384).default(2048),
  start: z.boolean().default(true),
});
export type CreateAgentBody = z.infer<typeof createAgentBody>;

export const updateAgentBody = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).optional(),
  image: z.string().trim().min(1).max(300).optional(),
  model: z.string().trim().min(3).max(120).optional(),
  spendLimitUsd: z.number().min(0.5).max(10_000).optional(),
  cpus: z.number().min(0.25).max(8).optional(),
  memoryMb: z.number().int().min(512).max(16_384).optional(),
  avatarPrompt: z.string().trim().max(2000).optional(),
  peers: z.array(z.string().regex(AGENT_ID_PATTERN)).max(50).optional(),
});
export type UpdateAgentBody = z.infer<typeof updateAgentBody>;

export interface ImageInfo {
  reference: string;
  id: string;
  created: string;
  sizeBytes: number;
  labels: Record<string, string>;
}

export interface PlatformOverview {
  temporal: { state: 'up' | 'down'; address: string; namespace: string; webUiUrl: string; version?: string };
  oauth: { state: 'up' | 'down'; issuer: string };
  runtime: { kind: string; state: 'up' | 'down'; detail?: string };
  agents: { total: number; running: number };
  tasks: { open: number; awaitingApproval: number; failed24h: number; completed24h: number };
}

export interface AdminAuditEntry {
  at: string;
  by: string;
  action: string;
  target: string;
  details?: Record<string, unknown>;
}

/* ---------------------------------------------------------------- identity */

export interface UserDto {
  id: string;
  email: string;
  name: string;
  disabled: boolean;
  /** Global roles such as `Platform.Admin`. */
  platformRoles: string[];
  /** Roles per agent id. The key `*` applies to every agent. */
  agentRoles: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

const roleList = z.array(z.string().min(1).max(60)).max(20);

export const createUserBody = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
  platformRoles: roleList.default([]),
  agentRoles: z.record(z.string(), roleList).default({}),
});
export type CreateUserBody = z.infer<typeof createUserBody>;

export const updateUserBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8).max(200).optional(),
  disabled: z.boolean().optional(),
  platformRoles: roleList.optional(),
  agentRoles: z.record(z.string(), roleList).optional(),
});
export type UpdateUserBody = z.infer<typeof updateUserBody>;

export interface ClientDto {
  clientId: string;
  name: string;
  kind: 'agent' | 'admin' | 'custom';
  agentId?: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  createdAt: string;
}

export const upsertClientBody = z.object({
  clientId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  name: z.string().min(1).max(120),
  kind: z.enum(['agent', 'admin', 'custom']),
  agentId: z.string().optional(),
  clientSecret: z.string().min(16).max(200),
  redirectUris: z.array(z.string().url()).min(1).max(10),
  postLogoutRedirectUris: z.array(z.string().url()).max(10).default([]),
});
export type UpsertClientBody = z.infer<typeof upsertClientBody>;
