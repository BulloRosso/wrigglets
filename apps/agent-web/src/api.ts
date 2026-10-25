import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@cw/ui';
import { moodForAgent, type AvatarMood } from '@cw/shared';
import type {
  AgentStatusResponse,
  AuditSearchResult,
  CommitInfo,
  CreateScheduleBody,
  CreateTaskBody,
  NotificationDto,
  PatchScheduleBody,
  Principal,
  ScheduleDto,
  TaskDetail,
  TaskChatMessage,
  TaskListItem,
  TaskState,
  Timeline,
  WorkspaceEntry,
} from '@cw/shared';

export interface Me {
  user: Principal;
  agent: { agentId: string; displayName: string };
  roles: { user: string; approver: string; admin: string };
  authMode: string;
  temporalUiUrl?: string;
  temporalNamespace: string;
}

export const api = {
  me: () => apiFetch<Me>('/api/me'),
  agentStatus: () => apiFetch<AgentStatusResponse>('/api/agent/status'),
  notifications: () => apiFetch<NotificationDto[]>('/api/notifications'),
  tasks: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as Array<[string, string]>);
    return apiFetch<{ items: TaskListItem[]; nextPageToken?: string }>(`/api/tasks?${qs}`);
  },
  createTask: (body: CreateTaskBody) => apiFetch<{ taskId: string }>('/api/tasks', { method: 'POST', json: body }),
  task: (id: string) => apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
  decide: (id: string, decision: 'approve' | 'reject' | 'revise', comment?: string) =>
    apiFetch<TaskState>(`/api/tasks/${encodeURIComponent(id)}/decision`, { method: 'POST', json: { decision, comment: comment || undefined } }),
  cancel: (id: string, reason?: string) => apiFetch<TaskState>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', json: { reason: reason || undefined } }),
  chat: (id: string) => apiFetch<TaskChatMessage[]>(`/api/tasks/${encodeURIComponent(id)}/chat`),
  sendChat: (id: string, text: string) => apiFetch<TaskChatMessage[]>(`/api/tasks/${encodeURIComponent(id)}/chat`, { method: 'POST', json: { text } }),
  comment: (id: string, text: string) => apiFetch<TaskState>(`/api/tasks/${encodeURIComponent(id)}/comments`, { method: 'POST', json: { text } }),
  taskTimeline: (id: string) => apiFetch<Timeline>(`/api/tasks/${encodeURIComponent(id)}/timeline`),
  timeline: (from: string, to: string) => apiFetch<Timeline & { range: { from: string; to: string } }>(`/api/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  schedules: () => apiFetch<ScheduleDto[]>('/api/schedules'),
  createSchedule: (body: CreateScheduleBody) => apiFetch<{ scheduleId: string }>('/api/schedules', { method: 'POST', json: body }),
  patchSchedule: (id: string, body: PatchScheduleBody) => apiFetch<ScheduleDto>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', json: body }),
  triggerSchedule: (id: string) => apiFetch<void>(`/api/schedules/${encodeURIComponent(id)}/trigger`, { method: 'POST' }),
  deleteSchedule: (id: string) => apiFetch<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  tree: (path: string) => apiFetch<{ path: string; entries: WorkspaceEntry[] }>(`/api/workspace/tree?path=${encodeURIComponent(path)}`),
  fileUrl: (path: string, download = false) => `/api/workspace/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
  fileText: async (path: string) => {
    const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
    if (!res.ok)
      throw new Error(
        res.status === 404
          ? 'This file no longer exists in the workspace — a task step may have moved or removed it (for example after a verification fix). The file list was refreshed.'
          : `Could not load file (${res.status})`,
      );
    return res.text();
  },
  commits: (params: { path?: string; taskId?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params.path) qs.set('path', params.path);
    if (params.taskId) qs.set('taskId', params.taskId);
    qs.set('limit', String(params.limit ?? 50));
    return apiFetch<CommitInfo[]>(`/api/workspace/commits?${qs}`);
  },
  commitDiff: (hash: string) => apiFetch<string>(`/api/workspace/commits/${hash}`),
  upload: async (files: File[], targetDir: string) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    form.append('targetDir', targetDir);
    return apiFetch<{ taskId: string; files: string[] }>('/api/workspace/uploads', { method: 'POST', body: form });
  },
  auditSearch: (params: Record<string, string>) => apiFetch<AuditSearchResult>(`/api/audit/search?${new URLSearchParams(params)}`),
  forceRelease: (taskId: string) => apiFetch<void>('/api/admin/agent/force-release', { method: 'POST', json: { taskId } }),
};

export const useAgentStatus = () => useQuery({ queryKey: ['agent-status'], queryFn: api.agentStatus, refetchInterval: 5_000 });
export const avatarUrl = (mood: AvatarMood) => `/api/avatar/${mood}`;

/** Mood of the agent as a whole, derived from its status. */
export function agentMood(s: AgentStatusResponse | undefined): AvatarMood {
  if (!s) return 'neutral';
  return moodForAgent({ healthy: s.health.status === 'ok', busy: !!s.holder, killSwitch: s.killSwitch?.level });
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 5 * 60_000 });

export function hasRole(me: Me | undefined, role: keyof Me['roles']) {
  return !!me && me.user.roles.includes(me.roles[role]);
}
