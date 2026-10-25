/** Identifier conventions shared by API, worker, workflows and admin plane. */

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export const agentWorkflowId = (agentId: string) => `agent-${agentId}`;

/**
 * Every agent has its own task queue. Workflows of agent A must never be picked up by the
 * worker of agent B because each worker owns a different workspace (see ADR-0005).
 */
export const agentTaskQueue = (agentId: string) => `agent-${agentId}`;

export const userScheduleId = (agentId: string, slug: string) => `sched-${agentId}-${slug}`;
export const systemScheduleId = (agentId: string, kind: string) => `sched-sys-${agentId}-${kind}`;
export const scheduledTaskIdPrefix = (scheduleId: string) => `task-${scheduleId}`;
export const maintenanceWorkflowId = (agentId: string, kind: string, date: string) =>
  `maint-${agentId}-${kind}-${date}`;

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'schedule';
}

/** Pattern of task ids: `task-<ULID>` or `task-sched-…-<RFC3339 timestamp>` for scheduled runs. */
export const TASK_ID_PATTERN = /^task-[A-Za-z0-9:._-]{3,120}$/;

/** File-system safe variant of a step id (`task-X:run:1` → `task-X_run_1`). */
export const stepFileName = (stepId: string) => stepId.replace(/[:/\\]/g, '_');

export const workspacePaths = {
  plan: (taskId: string) => `.agent/plans/${stepFileName(taskId)}.md`,
  summary: (stepId: string) => `.agent/summaries/${stepFileName(stepId)}.md`,
  stepResult: (stepId: string) => `.agent/steps/${stepFileName(stepId)}.json`,
  audit: (taskId: string, at: Date) =>
    `.agent/audit/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${stepFileName(taskId)}.json`,
};

export const artifactPaths = {
  transcript: (taskId: string, stepId: string) => `${stepFileName(taskId)}/${stepFileName(stepId)}-transcript.json`,
  verifyReport: (taskId: string, round: number) => `${stepFileName(taskId)}/verify-${round}.md`,
};
