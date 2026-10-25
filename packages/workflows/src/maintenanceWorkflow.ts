import { proxyActivities, upsertSearchAttributes, workflowInfo } from '@temporalio/workflow';
import { SA } from '@cw/shared/search-attributes';
import type { AgentActivities, MaintenanceResult } from './activity-types.js';
import { createWorkspaceLock } from './lock.js';

const acts = proxyActivities<AgentActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 3, initialInterval: '1 minute' },
});

export type MaintenanceKind = 'git' | 'backup' | 'artifacts';

export interface MaintenanceInput {
  agentId: string;
  kind: MaintenanceKind;
  /** Transcript retention for `artifacts` (default 180 days, spec §7.8). */
  retentionDays?: number;
}

/** System housekeeping started by the system schedules (spec §7.8). */
export async function maintenanceWorkflow(input: MaintenanceInput): Promise<MaintenanceResult> {
  const holderId = workflowInfo().workflowId;
  upsertSearchAttributes([{ key: SA.TaskStatus, value: 'running' }]);
  const lock = createWorkspaceLock(input.agentId, holderId, () => undefined);

  let result: MaintenanceResult;
  switch (input.kind) {
    case 'git':
      result = await lock.withWorkspace(() => acts.gitMaintenance({ summary: 'git gc + fsck' }));
      break;
    case 'backup':
      result = await lock.withWorkspace(() =>
        acts.backupWorkspace({ date: new Date().toISOString().slice(0, 10), summary: 'git bundle backup' }),
      );
      break;
    case 'artifacts':
      // Artifacts live outside the workspace: no lock required.
      result = await acts.cleanupArtifacts({ olderThanDays: input.retentionDays ?? 180, summary: 'artifact cleanup' });
      break;
  }
  upsertSearchAttributes([{ key: SA.TaskStatus, value: 'completed' }]);
  return result;
}
