import type { CommitMeta } from '@cw/workflows/activity-types';
import type { Trailers } from '../workspace/git.js';

/** Git trailers linking every commit to its Temporal execution (spec §8.2). */
export function stepTrailers(o: { meta: CommitMeta; taskId: string; workflowId: string; runId: string; stepId: string; extra?: Trailers }): Trailers {
  return {
    'Requested-By': o.meta.requestedBy,
    'Approved-By': o.meta.approvedBy,
    'Task-Id': o.taskId,
    'Workflow-Id': o.workflowId,
    'Run-Id': o.runId,
    'Step-Id': o.stepId,
    Trigger: o.meta.trigger,
    ...o.extra,
  };
}
