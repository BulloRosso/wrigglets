import { z } from 'zod';
import type { KillSwitchState } from './killswitch.js';

/*
 * MCP gateway configuration (ADR-0021). The control plane is the source of truth and serves the
 * effective configuration to the gateway (`GET /internal/gateway-config`). Credentials of upstream
 * MCP servers are never part of it — only Key Vault secret references.
 */

export const upstreamHeaderValue = z.union([z.string().max(2000), z.object({ secretRef: z.string().regex(/^[0-9a-zA-Z-]{1,127}$/) })]);
export type UpstreamHeaderValue = z.infer<typeof upstreamHeaderValue>;

export const upstreamServer = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lower-case letters, digits and dashes'),
  description: z.string().max(300).optional(),
  url: z.string().url(),
  /** Header values: literal (non-secret) or `{ secretRef }` resolved from Key Vault by the gateway. */
  headers: z.record(z.string(), upstreamHeaderValue).default({}),
  enabled: z.boolean().default(true),
  /**
   * `static`: the `headers` above are sent as-is (default, today's behaviour).
   * `obo`: the gateway sends a per-call Entra token (user + agent identity, Entra On-Behalf-Of).
   */
  auth: z.enum(['static', 'obo']).default('static'),
  /** Entra scope/resource requested for the token, e.g. `api://<mcp-app-id>/.default`. Required for `obo`. */
  oboScope: z.string().max(300).optional(),
  /** Non-interactive tasks (no signed-in user): `agent-only` = agent client-credentials token, `deny` = refuse. */
  oboFallback: z.enum(['deny', 'agent-only']).default('deny'),
}).refine((u) => u.auth !== 'obo' || !!u.oboScope, { message: 'oboScope is required when auth is obo', path: ['oboScope'] });
export type UpstreamServer = z.infer<typeof upstreamServer>;

export interface GatewayAgentConfig {
  agentId: string;
  displayName: string;
  /** sha256 (hex) of the agent's bearer token — the gateway never receives the token itself. */
  tokenSha256: string;
  /** A2A discovery set (ADR-0023). Empty = isolated. */
  peers: string[];
  /** Tool name patterns (`<upstream>__<tool>`, `*` wildcard) the agent may use. */
  allowedTools: string[];
  /** Internal base URL of the agent (A2A endpoint `/a2a`, agent card). */
  url: string;
  /** Entra OBO enabled for this agent (optional capability). */
  obo?: boolean;
  /** May use an agent-only (client-credentials) token for non-interactive tasks. */
  oboAllowAgentOnly?: boolean;
}

export interface GatewayLimits {
  callsPerMinute: number;
  maxArgBytes: number;
  callTimeoutMs: number;
}

export interface GatewayConfig {
  generatedAt: string;
  killSwitch: KillSwitchState;
  agents: GatewayAgentConfig[];
  upstreams: UpstreamServer[];
  limits: GatewayLimits;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = { callsPerMinute: 60, maxArgBytes: 64 * 1024, callTimeoutMs: 60_000 };

export interface ToolCallAuditEntry {
  at: string;
  agentId: string;
  tool: string;
  outcome: 'ok' | 'error' | 'denied';
  reason?: string;
  durationMs: number;
  argBytes: number;
  resultBytes?: number;
  /** For A2A: the peer and remote task id. */
  peer?: string;
  remoteTaskId?: string;
  /** Entra OBO: how the upstream was authenticated and on behalf of whom (never the token itself). */
  authMode?: 'static' | 'obo' | 'agent-only';
  userOid?: string;
}

export interface DelegationStatus {
  agentId: string;
  taskId: string;
  state: 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'rejected' | 'unknown';
  terminal: boolean;
  summary?: string;
  /** Result text (truncated) when completed. */
  result?: string;
}

export const A2A_TOOL = {
  list: 'a2a__list_agents',
  send: 'a2a__send_task',
  get: 'a2a__get_task',
} as const;

/** Glob-like match for tool allow-lists (`*` matches any sequence). */
export function toolAllowed(patterns: string[], tool: string): boolean {
  return patterns.some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(tool));
}
