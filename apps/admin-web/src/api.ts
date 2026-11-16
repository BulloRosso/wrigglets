import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@cw/ui';
import type { ExtensionStatus } from '@cw/extensions';
import type { IrDiff, OntologyIr } from '@cw/ontology-ir/browser';
import type { Playbook } from '@cw/playbooks';
import type {
  AdminAuditEntry,
  AgentEntra,
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
  GuardConfig,
  KillLevel,
  KillSwitchEntry,
  KillSwitchState,
  SafetyRule,
  ObservationInput,
  SignalsAgentConfig,
  SignalsConnectors,
  SignalsHubStatus,
  SecurityAlert,
  ToolCallAuditEntry,
  UpstreamServer,
} from '@cw/shared';
export type { ExtensionStatus } from '@cw/extensions';

/** A tightening policy overlay (ADR-0044). */
export interface PlaybookStepResult {
  id: string;
  type: string;
  autonomy: 'auto' | 'propose' | 'human';
  state: 'pending' | 'awaiting_approval' | 'running' | 'done' | 'failed' | 'skipped' | 'proposed' | 'cancelled';
  summary?: string;
  error?: string;
  data?: Record<string, unknown>;
  approvedBy?: string;
  decidedBy?: string;
  comment?: string;
  at?: string;
}
export interface PlaybookRunView {
  runId: string;
  workflowId: string;
  playbook: string;
  version: number;
  state: 'running' | 'awaiting_approval' | 'completed' | 'cancelled' | 'failed';
  trigger: { kind: string; data: Record<string, unknown> };
  blast: { upstream: string; tools: string[]; actions: string[]; writeActions: string[]; classes: string[]; objects: string[]; workflows: string[] } | null;
  steps: PlaybookStepResult[];
  cancelledBy?: string;
  startTime: string;
  closeTime: string | null;
}
export interface PlaybookList {
  playbooks: Playbook[];
  invalid: Array<{ path: string; issues: Array<{ path: string; message: string }> }>;
  sources: Record<string, string>;
}

export interface ConfigCheck {
  name: string;
  ok: boolean;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
}
export interface ConfigProposal {
  id: string;
  title: string;
  reason: string;
  evidence?: string;
  author: { kind: 'agent' | 'person'; id: string; user?: string; task?: string };
  createdAt: string;
  base: string;
  head: string;
  paths: string[];
  status: 'pending' | 'approved' | 'rejected' | 'conflict';
  validation: { ok: boolean; at: string; checks: ConfigCheck[] };
  owners: Array<{ for: string; owners: string[] }>;
  irDiff?: IrDiff;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  mergedAs?: string;
  diff?: string;
}
export interface ConfigStatus {
  initialized: boolean;
  head: string | null;
  applied: string | null;
  inSync: boolean;
  lastReconcile: { at: string; head: string | null; ok: boolean; changes: string[]; errors: Array<{ path: string; message: string }> } | null;
  pendingProposals: number;
  log: Array<{ commit: string; author: string; email: string; at: string; subject: string; body: string }>;
  files: string[];
  drift: string[];
}
export interface OntologyDraft {
  id: string;
  domain: string;
  base: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  ops: Array<Record<string, unknown> & { op: string }>;
  proposal?: string;
}
export interface DraftValidation {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
  ir?: OntologyIr;
  diff?: IrDiff;
}

export interface LiquidHoldState {
  held: boolean;
  holds: Array<{ ref: string; reason: string; since: string }>;
  state: string;
}
export interface LiquidApprovalState {
  state: 'pending' | 'reminded' | 'approved' | 'executed' | 'execution_failed' | 'rejected' | 'expired';
  request: { requestSeq: number; action: string; args: Record<string, unknown>; caller: { agent?: string; user?: string; task?: string }; target?: string; reason?: string; objects: string[] };
  decision?: { decision: 'approve' | 'reject'; by: string; comment?: string };
  result?: string;
}
export interface LiquidProcess {
  workflowId: string;
  type: string;
  status: string;
  startTime: string;
  closeTime: string | null;
  objects: string[];
  state: string | null;
  hold?: LiquidHoldState;
  approval?: LiquidApprovalState;
}
export interface LiquidProcesses {
  running: LiquidProcess[];
  recent: LiquidProcess[];
  held: number;
  pendingApprovals: number;
}

export interface LiquidOverlay {
  id: string;
  effect: 'deny' | 'require_four_eyes' | 'require_step_up';
  reason: string;
  match: { actions?: string[]; classes?: string[]; upstreams?: string[]; agents?: string[] };
  expires_at?: string;
  source: string;
  createdAt: string;
  createdBy: string;
}
export interface LiquidPolicyStatus {
  bundle: { revision: string; builtAt: string; files: string[] } | null;
  lastFetchByOpa: { at: string; revision: string; notModified: boolean } | null;
  overlays: LiquidOverlay[];
  decisions: Array<{ at: string; path: string; allow: boolean | null; reason: string | null; obligations: string[]; input: { agent?: string; action?: string; tool?: string; caller?: string } }>;
}

/** Event log and lake of Liquid Enterprise (ADR-0040). */
export interface LiquidLakeStatus {
  hwm: number;
  snapshots: number;
  lastSnapshotAt: string | null;
  extracts: Array<{ id: string; source: string; at: string; tables: Record<string, number> }>;
  lastFlush: { at: string; result: { flushed: number; hwm: number; waiting: number } } | null;
  eventLog: { count: number; maxSeq: number };
  counts: Record<string, number>;
  files: Record<string, number>;
}

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

/** Central company wiki (ADR-0035). */
export interface WikiPageInfo {
  path: string;
  title: string;
  updatedAt: string;
  updatedBy: string;
  chars: number;
  pending: number;
}
export interface WikiPage {
  path: string;
  content: string;
  updatedAt: string;
  updatedBy: string;
  note?: string;
  hash: string;
  history: Array<{ index: number; at: string; by: string; note?: string; chars: number }>;
}
export interface WikiProposal {
  id: string;
  path: string;
  content: string;
  /** Current text of the page (null: new page). */
  current: string | null;
  reason: string;
  evidence: string;
  agent: string;
  task?: string;
  requestedBy?: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  baseChanged?: boolean;
  edited?: boolean;
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
  agentsMd: (agentId: string) => apiFetch<{ content: string }>(`/api/agents/${id(agentId)}/agents-md`),
  saveAgentsMd: (agentId: string, content: string) => apiFetch<{ commit: string | null }>(`/api/agents/${id(agentId)}/agents-md`, { method: 'PUT', json: { content } }),
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
  guardConfig: () => apiFetch<{ config: GuardConfig; defaultSystemPrompt: string; defaults: GuardConfig; platformModel: string }>('/api/security/guard'),
  saveGuardConfig: (config: GuardConfig) => apiFetch<{ config: GuardConfig }>('/api/security/guard', { method: 'PUT', json: { config } }),
  securityAlerts: () => apiFetch<{ open: number; alerts: SecurityAlert[] }>('/api/security/alerts'),
  acknowledgeAlert: (alertId: string, note?: string) => apiFetch<SecurityAlert>(`/api/security/alerts/${id(alertId)}/acknowledge`, { method: 'POST', json: { note } }),
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
  entraAvailable: () => apiFetch<{ available: boolean; tenantId: string | null }>('/api/entra'),
  agentEntra: (agentId: string) => apiFetch<{ available: boolean; entra: AgentEntra | null }>(`/api/agents/${id(agentId)}/entra`),
  setAgentEntra: (agentId: string, entra: AgentEntra | null) => apiFetch<{ ok: boolean }>(`/api/agents/${id(agentId)}/entra`, { method: 'PUT', json: { entra } }),
  agentSpend: (agentId: string) => apiFetch<AgentSpend>(`/api/agents/${id(agentId)}/spend`),
  mails: (agentId?: string) => apiFetch<{ delivery: 'api' | 'file'; mails: MailRecord[] }>(`/api/mail${agentId ? `?agentId=${id(agentId)}` : ''}`),
  mailHtmlUrl: (mailId: string) => `/api/mail/${id(mailId)}/html`,
  wikiPages: () => apiFetch<WikiPageInfo[]>('/api/wiki/pages'),
  wikiPage: (path: string) => apiFetch<WikiPage>(`/api/wiki/page?path=${id(path)}`),
  wikiVersion: (path: string, index: number) => apiFetch<{ at: string; by: string; note?: string; content: string }>(`/api/wiki/version?path=${id(path)}&index=${index}`),
  saveWikiPage: (path: string, content: string, note?: string) => apiFetch<{ path: string }>('/api/wiki/page', { method: 'PUT', json: { path, content, note } }),
  deleteWikiPage: (path: string) => apiFetch<void>(`/api/wiki/page?path=${id(path)}`, { method: 'DELETE' }),
  wikiProposals: (status?: string) => apiFetch<WikiProposal[]>(`/api/wiki/proposals${status ? `?status=${status}` : ''}`),
  decideWikiProposal: (proposalId: string, decision: 'approve' | 'reject', comment?: string, content?: string) =>
    apiFetch<WikiProposal>(`/api/wiki/proposals/${id(proposalId)}/decide`, { method: 'POST', json: { decision, comment, content } }),
  /* Signals (optional module, ADR-0037) */
  signalsAvailable: () => apiFetch<{ available: boolean }>('/api/signals'),
  signalsOverview: () =>
    apiFetch<{ agents: string[]; connectors: Omit<SignalsConnectors, 'http'> & { http: Array<{ id: string; agentId: string; enabled: boolean }> }; status: SignalsHubStatus | { error: string } }>('/api/signals/overview'),
  saveSignalsConnectors: (body: Pick<SignalsConnectors, 'imap' | 'mqtt'>) => apiFetch<SignalsConnectors>('/api/signals/connectors', { method: 'PUT', json: body }),
  createSignalsHttpSource: (sourceId: string, agentId: string) => apiFetch<{ id: string; token: string }>('/api/signals/http-sources', { method: 'POST', json: { id: sourceId, agentId } }),
  deleteSignalsHttpSource: (sourceId: string) => apiFetch<void>(`/api/signals/http-sources/${id(sourceId)}`, { method: 'DELETE' }),
  agentSignals: (agentId: string) => apiFetch<{ available: boolean; config: SignalsAgentConfig }>(`/api/agents/${id(agentId)}/signals`),
  setAgentSignals: (agentId: string, config: SignalsAgentConfig) => apiFetch<SignalsAgentConfig>(`/api/agents/${id(agentId)}/signals`, { method: 'PUT', json: config }),
  sendObservation: (agentId: string, o: ObservationInput) => apiFetch<{ observationId: string; duplicate: boolean }>(`/api/agents/${id(agentId)}/signals/observations`, { method: 'POST', json: o }),
  /* Optional extensions installed from the console (ADR-0039) */
  extensions: () => apiFetch<ExtensionStatus[]>('/api/extensions'),
  extension: (extId: string) => apiFetch<ExtensionStatus>(`/api/extensions/${id(extId)}`),
  installExtension: (extId: string, seedDemo: boolean) => apiFetch<ExtensionStatus>(`/api/extensions/${id(extId)}/install`, { method: 'POST', json: { seedDemo } }),
  repairExtension: (extId: string) => apiFetch<ExtensionStatus>(`/api/extensions/${id(extId)}/repair`, { method: 'POST', json: {} }),
  uninstallExtension: (extId: string, purgeData: boolean) => apiFetch<ExtensionStatus>(`/api/extensions/${id(extId)}/uninstall`, { method: 'POST', json: { purgeData } }),
  liquidLake: () => apiFetch<LiquidLakeStatus>('/api/liquid/lake'),
  liquidOntology: () => apiFetch<OntologyIr>('/api/liquid/ontology'),
  liquidPlaybooks: () => apiFetch<PlaybookList>('/api/liquid/playbooks'),
  liquidPlaybookRuns: () => apiFetch<PlaybookRunView[]>('/api/liquid/playbooks/runs'),
  decidePlaybookStep: (runId: string, stepId: string, decision: 'approve' | 'reject', comment?: string) => apiFetch<unknown>(`/api/liquid/playbooks/runs/${id(runId)}/steps/${id(stepId)}/decide`, { method: 'POST', json: { decision, comment } }),
  cancelPlaybookRun: (runId: string) => apiFetch<unknown>(`/api/liquid/playbooks/runs/${id(runId)}/cancel`, { method: 'POST', json: {} }),
  sendPlaybookAlert: (alert: Record<string, unknown>) => apiFetch<{ runs: Array<{ runId: string; playbook: string }> }>('/api/liquid/playbooks/alerts', { method: 'POST', json: alert }),
  liquidConfig: () => apiFetch<ConfigStatus>('/api/liquid/config'),
  reconcileLiquidConfig: () => apiFetch<unknown>('/api/liquid/config/reconcile', { method: 'POST' }),
  liquidProposals: () => apiFetch<ConfigProposal[]>('/api/liquid/proposals'),
  liquidProposal: (pid: string) => apiFetch<ConfigProposal>(`/api/liquid/proposals/${id(pid)}`),
  liquidProposalIr: (pid: string) => apiFetch<OntologyIr | null>(`/api/liquid/proposals/${id(pid)}/ir`),
  decideLiquidProposal: (pid: string, decision: 'approve' | 'reject', comment?: string) => apiFetch<ConfigProposal>(`/api/liquid/proposals/${id(pid)}/decide`, { method: 'POST', json: { decision, comment } }),
  createOntologyDraft: (domain = 'sofa') => apiFetch<OntologyDraft>('/api/liquid/ontology/drafts', { method: 'POST', json: { domain } }),
  ontologyDrafts: () => apiFetch<OntologyDraft[]>('/api/liquid/ontology/drafts'),
  ontologyDraft: (did: string) => apiFetch<OntologyDraft>(`/api/liquid/ontology/drafts/${id(did)}`),
  applyDraftOps: (did: string, ops: Array<Record<string, unknown>>) => apiFetch<OntologyDraft>(`/api/liquid/ontology/drafts/${id(did)}/ops`, { method: 'POST', json: { ops } }),
  validateDraft: (did: string) => apiFetch<DraftValidation>(`/api/liquid/ontology/drafts/${id(did)}/validate`, { method: 'POST' }),
  submitDraft: (did: string, title: string, reason: string) => apiFetch<ConfigProposal>(`/api/liquid/ontology/drafts/${id(did)}/submit`, { method: 'POST', json: { title, reason } }),
  deleteDraft: (did: string) => apiFetch<void>(`/api/liquid/ontology/drafts/${id(did)}`, { method: 'DELETE' }),
  liquidPolicy: () => apiFetch<LiquidPolicyStatus>('/api/liquid/policy'),
  addLiquidOverlay: (o: Pick<LiquidOverlay, 'effect' | 'reason' | 'match' | 'expires_at'>) => apiFetch<LiquidOverlay>('/api/liquid/policy/overlays', { method: 'POST', json: o }),
  liquidProcesses: () => apiFetch<LiquidProcesses>('/api/liquid/processes'),
  holdLiquidProcesses: (objects: string[], reason: string) => apiFetch<{ ref: string; workflows: string[] }>('/api/liquid/processes/hold', { method: 'POST', json: { objects, reason } }),
  releaseLiquidHold: (ref: string) => apiFetch<{ ref: string; workflows: string[] }>('/api/liquid/processes/release', { method: 'POST', json: { ref } }),
  decideLiquidApproval: (workflowId: string, decision: 'approve' | 'reject', comment?: string) => apiFetch<LiquidApprovalState>(`/api/liquid/approvals/${id(workflowId)}/decide`, { method: 'POST', json: { decision, comment } }),
  removeLiquidOverlay: (overlayId: string) => apiFetch<void>(`/api/liquid/policy/overlays/${id(overlayId)}`, { method: 'DELETE' }),
  extensionLogs: (extId: string, service: string) =>
    fetch(`/api/extensions/${id(extId)}/services/${id(service)}/logs?tail=300`, { credentials: 'same-origin' }).then(async (r) => {
      if (!r.ok) throw new Error(`logs: HTTP ${r.status}`);
      return r.text();
    }),
  audit: (target?: string) => apiFetch<AdminAuditEntry[]>(`/api/audit${target ? `?target=${id(target)}` : ''}`),
};

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 5 * 60_000 });

export const avatarSrc = (agentId: string) => (mood: AvatarMood) => `/api/agents/${id(agentId)}/avatar/${mood}`;
export type { KillSwitchEntry };
