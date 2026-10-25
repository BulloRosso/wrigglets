import { ScheduleAlreadyRunning, ScheduleOverlapPolicy, type Client } from '@temporalio/client';
import { SCHEDULE_TIMEZONE, agentWorkflowId, systemScheduleId } from '@cw/shared';
import { SA } from '@cw/shared/search-attributes';
import type { MaintenanceInput } from '@cw/workflows';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

/** Boot step 7 (spec §5.2): ensure the singleton lock-manager workflow is running. */
export async function ensureAgentWorkflow(client: Client, config: Config): Promise<void> {
  const workflowId = agentWorkflowId(config.AGENT_ID);
  const handle = await client.workflow.start('agentWorkflow', {
    workflowId,
    taskQueue: config.taskQueue,
    args: [{ agentId: config.AGENT_ID }],
    workflowIdConflictPolicy: 'USE_EXISTING',
    typedSearchAttributes: [{ key: SA.AgentId, value: config.AGENT_ID }],
    staticSummary: `Workspace lock manager of ${config.AGENT_DISPLAY_NAME}`,
  });
  logger.info({ workflowId, runId: handle.firstExecutionRunId }, 'agent workflow ensured');
}

const SYSTEM_SCHEDULES: Array<{ kind: MaintenanceInput['kind']; slug: string; cron: string; title: string }> = [
  { kind: 'git', slug: 'git-maintenance', cron: '10 3 * * 0', title: 'Git maintenance (gc + fsck)' },
  { kind: 'backup', slug: 'backup', cron: '40 2 * * *', title: 'Workspace backup (git bundle)' },
  { kind: 'artifacts', slug: 'artifact-cleanup', cron: '40 3 * * *', title: 'Transcript cleanup' },
];

/** Boot step 8 (spec §7.8): system schedules, created if missing. */
export async function ensureSystemSchedules(client: Client, config: Config): Promise<void> {
  if (!config.SYSTEM_SCHEDULES_ENABLED) return;
  for (const s of SYSTEM_SCHEDULES) {
    const scheduleId = systemScheduleId(config.AGENT_ID, s.slug);
    try {
      await client.schedule.create({
        scheduleId,
        spec: { cronExpressions: [s.cron], timezone: SCHEDULE_TIMEZONE },
        action: {
          type: 'startWorkflow',
          workflowType: 'maintenanceWorkflow',
          workflowId: `maint-${config.AGENT_ID}-${s.kind}`,
          taskQueue: config.taskQueue,
          args: [{ agentId: config.AGENT_ID, kind: s.kind, retentionDays: config.TRANSCRIPT_RETENTION_DAYS } satisfies MaintenanceInput],
          typedSearchAttributes: [
            { key: SA.AgentId, value: config.AGENT_ID },
            { key: SA.TaskType, value: 'maintenance' },
            { key: SA.TaskTitle, value: s.title },
            { key: SA.Trigger, value: 'schedule' },
            { key: SA.ScheduleId, value: scheduleId },
            { key: SA.RequestedBy, value: 'system' },
          ],
          staticSummary: s.title,
        },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
        memo: { system: true, title: s.title, cron: s.cron },
        typedSearchAttributes: [{ key: SA.AgentId, value: config.AGENT_ID }],
        state: { note: 'system schedule (created at boot)' },
      });
      logger.info({ scheduleId }, 'system schedule created');
    } catch (err) {
      if (!(err instanceof ScheduleAlreadyRunning)) throw err;
    }
  }
}
