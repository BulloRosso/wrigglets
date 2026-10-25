import type { AgentActivities, AgentLocalActivities } from '@cw/workflows/activity-types';
import type { ActivityDeps } from './deps.js';
import { createFinalizeTask } from './finalize.js';
import { createIsWorkflowRunning, createMaintenance, createNotify } from './misc.js';
import { createRunAgentStep } from './runAgentStep.js';
import { createApplyUpload } from './upload.js';
import { createVerify } from './verify.js';

export type { ActivityDeps } from './deps.js';

export function createActivities(deps: ActivityDeps): AgentActivities & AgentLocalActivities {
  const maintenance = createMaintenance(deps);
  return {
    runAgentStep: createRunAgentStep(deps),
    verify: createVerify(deps),
    applyUpload: createApplyUpload(deps),
    finalizeTask: createFinalizeTask(deps),
    notify: createNotify(deps),
    isWorkflowRunning: createIsWorkflowRunning(deps),
    checkDelegations: ({ delegations }) => deps.gateway.delegationStatus(delegations),
    gitMaintenance: () => maintenance.gitMaintenance(),
    backupWorkspace: (i) => maintenance.backupWorkspace(i),
    cleanupArtifacts: (i) => maintenance.cleanupArtifacts(i),
  };
}
