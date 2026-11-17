import { condition, defineQuery, defineSignal, defineUpdate, proxyActivities, setHandler, upsertSearchAttributes, workflowInfo } from '@temporalio/workflow';
import { BSA, type ActionCaller, type BusinessActivities } from './common.js';
import { holdable } from './hold.js';

/*
 * ApprovalWorkflow (ADR-0045, generalised in ADR-0049): the one way a person decides something in Liquid Enterprise.
 * Kinds:
 *   action        a four-eyes obligation (ADR-0044) stopped an action; approve → it runs with `approvedBy`
 *   playbook-step a human step of a playbook (child of PlaybookRun, which reads the decision from the result)
 *   wiki          a company-wiki proposal (mirrored by the control plane); the decision is applied to the wiki
 * Waits for `decide` (update with validator: one decision, not after expiry, never by the requester); reminds once;
 * expires; `withdraw` ends it when the request was decided elsewhere. Every approval is listed in one inbox and mailed
 * with a deep link by the control plane.
 */

export type ApprovalKind = 'action' | 'playbook-step' | 'wiki';

export interface ApprovalInput {
  kind?: ApprovalKind;
  /** One line for the inbox and the mail. */
  subject?: string;
  requestSeq: number;
  action: string;
  args: Record<string, unknown>;
  caller: ActionCaller;
  target?: string;
  reason?: string;
  /** Ontology objects the action touches (for holds and the UI). */
  objects: string[];
  /** What the decision applies to for kinds other than `action` (e.g. { proposalId } or { runId, stepId }). */
  effect?: Record<string, unknown>;
  reminderMs: number;
  expireMs: number;
}

export interface Decision {
  decision: 'approve' | 'reject';
  by: string;
  comment?: string;
}

export interface ApprovalState {
  state: 'pending' | 'reminded' | 'approved' | 'executed' | 'execution_failed' | 'rejected' | 'expired' | 'withdrawn';
  kind: ApprovalKind;
  subject: string;
  request: Pick<ApprovalInput, 'requestSeq' | 'action' | 'args' | 'caller' | 'target' | 'reason' | 'objects' | 'effect'>;
  decision?: Decision;
  result?: string;
}

/** Applies a decision outside the ontology (wiki, …): implemented by the control plane. */
export interface ApprovalEffects {
  applyDecision(i: { kind: ApprovalKind; effect: Record<string, unknown>; decision: Decision; workflowId: string }): Promise<{ ok: boolean; result: string }>;
}

export const decideUpdate = defineUpdate<ApprovalState, [Decision]>('decide');
export const approvalStateQuery = defineQuery<ApprovalState>('approvalState');
export const withdrawSignal = defineSignal<[{ reason: string }]>('withdraw');

const acts = proxyActivities<BusinessActivities & ApprovalEffects>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 10, initialInterval: '2 seconds' } });

export async function ApprovalWorkflow(input: ApprovalInput): Promise<ApprovalState> {
  const { reminderMs, expireMs, kind: k, subject: subj, ...request } = input;
  const kind: ApprovalKind = k ?? 'action';
  const subject = subj ?? `${input.action}${input.target ? ` on ${input.target}` : ''}`;
  const s: ApprovalState = { state: 'pending', kind, subject, request };
  let withdrawn: string | undefined;
  const h = holdable('pending_approval');
  setHandler(approvalStateQuery, () => s);
  setHandler(withdrawSignal, ({ reason }) => {
    if (!s.decision) withdrawn = reason;
  });
  setHandler(
    decideUpdate,
    (d) => {
      s.decision = { decision: d.decision, by: d.by, comment: d.comment };
      return s;
    },
    {
      validator: (d) => {
        if (s.decision) throw new Error(`already decided: ${s.decision.decision} by ${s.decision.by}`);
        if (s.state === 'expired' || withdrawn) throw new Error(withdrawn ? `withdrawn: ${withdrawn}` : 'the request has expired');
        if (d.decision !== 'approve' && d.decision !== 'reject') throw new Error('decision must be approve or reject');
        if (!d.by) throw new Error('the deciding person is required');
        if (d.by === input.caller.user || d.by === input.caller.agent) throw new Error('four eyes: the requester cannot approve their own request');
      },
    },
  );
  upsertSearchAttributes([{ key: BSA.OntologyObjects, value: input.objects.length ? input.objects : [`Approval:${kind}`] }]);

  const decided = () => !!s.decision || !!withdrawn;
  if (!(await condition(decided, reminderMs))) {
    s.state = 'reminded';
    await acts.notify({ kind: 'approval_reminder', subject: `Approval still pending: ${subject}`, body: `Request ${input.requestSeq} by ${input.caller.agent ?? input.caller.user ?? 'unknown'} waits for a decision${input.reason ? ` (${input.reason})` : ''}.`, ref: workflowInfo().workflowId });
    if (!(await condition(decided, Math.max(0, expireMs - reminderMs)))) {
      s.state = 'expired';
      h.setState('expired');
      return s;
    }
  }
  if (withdrawn) {
    s.state = 'withdrawn';
    s.result = withdrawn;
    h.setState('withdrawn');
    return s;
  }
  const d = s.decision!;
  if (kind !== 'action') {
    // playbook steps are applied by the parent run; other kinds by the control plane
    if (kind !== 'playbook-step') {
      const out = await acts.applyDecision({ kind, effect: input.effect ?? {}, decision: d, workflowId: workflowInfo().workflowId });
      s.result = out.result.slice(0, 2000);
    }
    s.state = d.decision === 'approve' ? 'approved' : 'rejected';
    h.setState(s.state);
    return s;
  }
  if (d.decision === 'reject') {
    s.state = 'rejected';
    h.setState('rejected');
    return s;
  }
  s.state = 'approved';
  h.setState('approved');
  await h.whileHeld();
  const out = await acts.runAction({ action: input.action, args: input.args, caller: { ...input.caller, approvedBy: d.by, workflow: workflowInfo().workflowId } });
  s.state = out.ok ? 'executed' : 'execution_failed';
  s.result = out.result.slice(0, 2000);
  h.setState(s.state);
  return s;
}
