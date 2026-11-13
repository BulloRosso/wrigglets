import type { AgentActivities, AgentLocalActivities } from '@cw/workflows/activity-types';
import type { SignalsActivities } from '@cw/signals/activity-types';
import { createSignalsActivities } from '../signals/activities.js';
import type { ActivityDeps } from './deps.js';
import { createFinalizeTask } from './finalize.js';
import { createIsWorkflowRunning, createMaintenance, createNotify } from './misc.js';
import { createRunAgentStep } from './runAgentStep.js';
import { createReportSecurityAlert } from './security.js';
import { createApplyUpload } from './upload.js';
import { createVerify } from './verify.js';

export type { ActivityDeps } from './deps.js';

export function createActivities(deps: ActivityDeps): AgentActivities & AgentLocalActivities & SignalsActivities {
  const maintenance = createMaintenance(deps);
  return {
    ...createSignalsActivities(deps),
    runAgentStep: createRunAgentStep(deps),
    verify: createVerify(deps),
    applyUpload: createApplyUpload(deps),
    finalizeTask: createFinalizeTask(deps),
    notify: createNotify(deps),
    reportSecurityAlert: createReportSecurityAlert(deps),
    isWorkflowRunning: createIsWorkflowRunning(deps),
    checkDelegations: ({ delegations }) => deps.gateway.delegationStatus(delegations),
    gitMaintenance: () => maintenance.gitMaintenance(),
    backupWorkspace: (i) => maintenance.backupWorkspace(i),
    cleanupArtifacts: (i) => maintenance.cleanupArtifacts(i),
  };
}
