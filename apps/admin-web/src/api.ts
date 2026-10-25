import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@cw/ui';
import type {
  AdminAuditEntry,
  AgentRuntimeInfo,
  AgentStats,
  AgentSummary,
  ClientDto,
  CreateAgentBody,
  CreateUserBody,
  ImageInfo,
  PlatformOverview,
  Principal,
  TaskListItem,
  UpdateAgentBody,
  UpdateUserBody,
  UserDto,
  AgentAiDetails,
  AgentSpend,
  AiStatus,
  AvatarJob,
  AvatarMood,
  AvatarStatus,
  EffectiveKillSwitch,
  KillLevel,
  KillSwitchEntry,
  KillSwitchState,
  SafetyRule,
  ToolCallAuditEntry,
  UpstreamServer,
} from '@cw/shared';

export interface AdminMe {
  user: Principal;
  temporalUiUrl: string;
  temporalNamespace: string;
  runtime: string;
  oauthIssuer: string;
}

export interface AccessRow {
  userId: string;
  email: string;
  name: string;
  disabled: boolean;
  roles: string[];
  inheritedRoles: string[];
}

export interface RuleObservation {
  agentId: string;
  ruleId: string;
  value: number;
  threshold: number;
  tripped: boolean;
}

export interface SecretInfo {
  name: string;
  enabled: boolean;
  updatedOn?: string;
  contentType?: string;
  tags?: Record<string, string>;
}

export interface GatewayInfo {
  health: { status?: string; stale?: boolean; [k: string]: unknown };
  upstreams: UpstreamServer[];
  tools: Array<{ name: string; description?: string }>;
}

export interface MailRecord {
  id: string;
  at: string;
  agentId: string;
  agentName: string;
  taskId?: string;
  kind: string;
  to: string[];
  subject: string;
  delivery: 'api' | 'file';
  status: 'sent' | 'failed' | 'written';
  error?: string;
}

export type AgentTask = TaskListItem & { agentId: string };

const id = encodeURIComponent;

export const api = {
  me: () => apiFetch<AdminMe>('/api/me'),
  overview: () => apiFetch<PlatformOverview>('/api/overview'),
  tasks: (params: { agentId?: string; status?: string; limit?: number } = {}) =>
    apiFetch<AgentTask[]>(`/api/tasks?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  agents: (health = true) => apiFetch<AgentSummary[]>(`/api/agents?health=${health}`),
  agent: (agentId: string) => apiFetch<AgentSummary>(`/api/agents/${id(agentId)}`),
  createAgent: (body: CreateAgentBody) => apiFetch<AgentSummary>('/api/agents', { method: 'POST', json: body }),
  updateAgent: (agentId: string, body: UpdateAgentBody) => apiFetch<AgentSummary>(`/api/agents/${id(agentId)}`, { method: 'PATCH', json: body }),
  agentAction: (agentId: string, action: 'start' | 'stop' | 'restart' | 'redeploy') => apiFetch<AgentRuntimeInfo>(`/api/agents/${id(agentId)}/${action}`, { method: 'POST' }),
  deleteAgent: (agentId: string, purgeData: boolean, removeAccess: boolean) =>
    apiFetch<{ schedules: number; workflows: number }>(`/api/agents/${id(agentId)}?purgeData=${purgeData}&removeAccess=${removeAccess}`, { method: 'DELETE' }),
  stats: (agentId: string) => apiFetch<AgentStats | null>(`/api/agents/${id(agentId)}/stats`),
  access: (agentId: string) => apiFetch<AccessRow[]>(`/api/agents/${id(agentId)}/access`),
  setAccess: (agentId: string, userId: string, roles: string[]) => apiFetch<UserDto>(`/api/agents/${id(agentId)}/access/${id(userId)}`, { method: 'PUT', json: { roles } }),
  images: () => apiFetch<ImageInfo[]>('/api/images'),
  users: () => apiFetch<UserDto[]>('/api/users'),
  createUser: (body: CreateUserBody) => apiFetch<UserDto>('/api/users', { method: 'POST', json: body }),
  updateUser: (userId: string, body: UpdateUserBody) => apiFetch<UserDto>(`/api/users/${id(userId)}`, { method: 'PATCH', json: body }),
  revokeSessions: (userId: string) => apiFetch<{ revoked: number }>(`/api/users/${id(userId)}/revoke-sessions`, { method: 'POST' }),
  deleteUser: (userId: string) => apiFetch<void>(`/api/users/${id(userId)}`, { method: 'DELETE' }),
  clients: () => apiFetch<ClientDto[]>('/api/clients'),
  killSwitch: () => apiFetch<{ state: KillSwitchState; effective: Record<string, EffectiveKillSwitch> }>('/api/killswitch'),
  setGlobalKillSwitch: (level: KillLevel, reason?: string) => apiFetch<KillSwitchState>('/api/killswitch', { method: 'PUT', json: { level, reason } }),
  setAgentKillSwitch: (agentId: string, level: KillLevel, reason?: string) =>
    apiFetch<EffectiveKillSwitch>(`/api/agents/${id(agentId)}/killswitch`, { method: 'PUT', json: { level, reason } }),
  safetyRules: () => apiFetch<{ rules: SafetyRule[]; lastRun?: string; observations: RuleObservation[] }>('/api/safety/rules'),
  saveSafetyRules: (rules: SafetyRule[]) => apiFetch<{ rules: SafetyRule[] }>('/api/safety/rules', { method: 'PUT', json: { rules } }),
  runSafety: () => apiFetch<{ observations: RuleObservation[]; lastRun?: string }>('/api/safety/run', { method: 'POST' }),
  gateway: () => apiFetch<GatewayInfo>('/api/gateway'),
  saveUpstream: (u: UpstreamServer) => apiFetch<UpstreamServer>(`/api/gateway/upstreams/${id(u.name)}`, { method: 'PUT', json: u }),
  deleteUpstream: (name: string) => apiFetch<void>(`/api/gateway/upstreams/${id(name)}`, { method: 'DELETE' }),
  agentTools: (agentId: string) => apiFetch<{ allowedTools: string[] }>(`/api/agents/${id(agentId)}/tools`),
  setAgentTools: (agentId: string, allowedTools: string[]) => apiFetch<{ allowedTools: string[] }>(`/api/agents/${id(agentId)}/tools`, { method: 'PUT', json: { allowedTools } }),
  toolCalls: (agentId: string) => apiFetch<ToolCallAuditEntry[]>(`/api/agents/${id(agentId)}/tool-calls`),
  secrets: () => apiFetch<{ enabled: boolean; vaultUrl?: string; secrets: SecretInfo[] }>('/api/secrets'),
  setSecret: (name: string, value: string) => apiFetch<void>(`/api/secrets/${id(name)}`, { method: 'PUT', json: { value } }),
  deleteSecret: (name: string) => apiFetch<void>(`/api/secrets/${id(name)}`, { method: 'DELETE' }),
  avatar: (agentId: string) => apiFetch<AvatarStatus>(`/api/agents/${id(agentId)}/avatar`),
  generateAvatar: (agentId: string, prompt?: string, moods?: AvatarMood[]) =>
    apiFetch<AvatarJob>(`/api/agents/${id(agentId)}/avatar`, { method: 'POST', json: { prompt, moods } }),
  uploadReference: (file: Blob) => apiFetch<void>('/api/avatars/reference', { method: 'PUT', body: file, headers: { 'content-type': 'image/png' } }),
  resetReference: () => apiFetch<void>('/api/avatars/reference', { method: 'DELETE' }),
  ai: () => apiFetch<{ status: AiStatus; agents: AgentSpend[] }>('/api/ai'),
  agentAi: (agentId: string) => apiFetch<AgentAiDetails>(`/api/agents/${id(agentId)}/ai`),
  setAgentAi: (agentId: string, body: { spendLimitUsd?: number; model?: string }) => apiFetch<{ ok: boolean; redeployed: boolean }>(`/api/agents/${id(agentId)}/ai`, { method: 'PUT', json: body }),
  rotateAgentKey: (agentId: string) => apiFetch<{ ok: boolean }>(`/api/agents/${id(agentId)}/ai/rotate`, { method: 'POST' }),
  blockAgentKey: (agentId: string, blocked: boolean) => apiFetch<{ ok: boolean }>(`/api/agents/${id(agentId)}/ai/block`, { method: 'POST', json: { blocked } }),
  agentSpend: (agentId: string) => apiFetch<AgentSpend>(`/api/agents/${id(agentId)}/spend`),
  mails: (agentId?: string) => apiFetch<{ delivery: 'api' | 'file'; mails: MailRecord[] }>(`/api/mail${agentId ? `?agentId=${id(agentId)}` : ''}`),
  mailHtmlUrl: (mailId: string) => `/api/mail/${id(mailId)}/html`,
  audit: (target?: string) => apiFetch<AdminAuditEntry[]>(`/api/audit${target ? `?target=${id(target)}` : ''}`),
};

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 5 * 60_000 });

export const avatarSrc = (agentId: string) => (mood: AvatarMood) => `/api/agents/${id(agentId)}/avatar/${mood}`;
export type { KillSwitchEntry };
