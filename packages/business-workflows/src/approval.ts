import { condition, defineQuery, defineUpdate, proxyActivities, setHandler, upsertSearchAttributes, workflowInfo } from '@temporalio/workflow';
import { BSA, type ActionCaller, type BusinessActivities } from './common.js';
import { holdable } from './hold.js';

/*
 * ApprovalWorkflow (ADR-0045): a person decides on an action that a policy obligation (require_four_eyes, ADR-0044)
 * stopped. Started by the dispatcher for every ActionApprovalRequested event. Waits for `decide`; reminds once; expires.
 * Approve → the action runs through the normal pipeline with `approvedBy` (the ontology server accepts that only from
 * trusted callers); reject/expire → nothing happens. The approver must not be the requesting person or agent.
 */

export interface ApprovalInput {
  requestSeq: number;
  action: string;
  args: Record<string, unknown>;
  caller: ActionCaller;
  target?: string;
  reason?: string;
  /** Ontology objects the action touches (for holds and the UI). */
  objects: string[];
  reminderMs: number;
  expireMs: number;
}

export interface Decision {
  decision: 'approve' | 'reject';
  by: string;
  comment?: string;
}

export interface ApprovalState {
  state: 'pending' | 'reminded' | 'approved' | 'executed' | 'execution_failed' | 'rejected' | 'expired';
  request: Pick<ApprovalInput, 'requestSeq' | 'action' | 'args' | 'caller' | 'target' | 'reason' | 'objects'>;
  decision?: Decision;
  result?: string;
}

export const decideUpdate = defineUpdate<ApprovalState, [Decision]>('decide');
export const approvalStateQuery = defineQuery<ApprovalState>('approvalState');

const acts = proxyActivities<BusinessActivities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 10, initialInterval: '2 seconds' } });

export async function ApprovalWorkflow(input: ApprovalInput): Promise<ApprovalState> {
  const { reminderMs, expireMs, ...request } = input;
  const s: ApprovalState = { state: 'pending', request };
  const h = holdable('pending_approval');
  setHandler(approvalStateQuery, () => s);
  setHandler(
    decideUpdate,
    (d) => {
      s.decision = { decision: d.decision, by: d.by, comment: d.comment };
      return s;
    },
    {
      validator: (d) => {
        if (s.decision) throw new Error(`already decided: ${s.decision.decision} by ${s.decision.by}`);
        if (s.state === 'expired') throw new Error('the request has expired');
        if (d.decision !== 'approve' && d.decision !== 'reject') throw new Error('decision must be approve or reject');
        if (!d.by) throw new Error('the deciding person is required');
        if (d.by === input.caller.user || d.by === input.caller.agent) throw new Error('four eyes: the requester cannot approve their own request');
      },
    },
  );
  upsertSearchAttributes([{ key: BSA.OntologyObjects, value: input.objects.length ? input.objects : [`Action:${input.action}`] }]);

  if (!(await condition(() => !!s.decision, reminderMs))) {
    s.state = 'reminded';
    await acts.notify({ kind: 'approval_reminder', subject: `Approval still pending: ${input.action}`, body: `Request ${input.requestSeq} by ${input.caller.agent ?? input.caller.user ?? 'unknown'} waits for a decision${input.reason ? ` (${input.reason})` : ''}.`, ref: workflowInfo().workflowId });
    if (!(await condition(() => !!s.decision, Math.max(0, expireMs - reminderMs)))) {
      s.state = 'expired';
      h.setState('expired');
      return s;
    }
  }
  if (s.decision!.decision === 'reject') {
    s.state = 'rejected';
    h.setState('rejected');
    return s;
  }
  s.state = 'approved';
  h.setState('approved');
  await h.whileHeld();
  const out = await acts.runAction({ action: input.action, args: input.args, caller: { ...input.caller, approvedBy: s.decision!.by, workflow: workflowInfo().workflowId } });
  s.state = out.ok ? 'executed' : 'execution_failed';
  s.result = out.result.slice(0, 2000);
  h.setState(s.state);
  return s;
}
