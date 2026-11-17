import { CancellationScope, ParentClosePolicy, condition, defineQuery, defineSignal, proxyActivities, setHandler, startChild, upsertSearchAttributes, workflowInfo } from '@temporalio/workflow';
import { ApprovalWorkflow } from './approval.js';
import { directionOf, render, type BlastRadius, type Playbook } from '@cw/playbooks';
import { BSA } from './common.js';

/*
 * PlaybookRun (ADR-0047): one run of a playbook, durable across restarts. Steps run in order:
 *   auto    → executed now
 *   propose → executed in "propose" mode: it creates something a person decides later (agent task, config proposal);
 *             the run does not wait
 *   human   → the run waits for a person's decision: a child ApprovalWorkflow (the one approval mechanism, ADR-0049,
 *             listed in the inbox and mailed); approve → executed with approvedBy
 * Loosening steps are only possible as human steps (validator + control plane check again). Cancelling stops the run
 * before its next step and never loosens anything. Every step result is recorded as an event by the control plane.
 */

export interface StepResult {
  id: string;
  type: string;
  autonomy: 'auto' | 'propose' | 'human';
  state: 'pending' | 'awaiting_approval' | 'running' | 'done' | 'failed' | 'skipped' | 'proposed' | 'cancelled';
  summary?: string;
  error?: string;
  /** What a restore needs to undo this step (tightening steps). */
  undo?: Record<string, unknown>;
  data?: Record<string, unknown>;
  approvedBy?: string;
  /** The ApprovalWorkflow that decides this human step. */
  approvalWorkflowId?: string;
  decidedBy?: string;
  comment?: string;
  at?: string;
}

export interface PlaybookRunInput {
  runId: string;
  playbook: Playbook;
  trigger: { kind: string; data: Record<string, unknown> };
  startedBy: string;
}

export interface PlaybookRunState {
  runId: string;
  playbook: string;
  version: number;
  state: 'running' | 'awaiting_approval' | 'completed' | 'cancelled' | 'failed';
  trigger: PlaybookRunInput['trigger'];
  blast: BlastRadius | null;
  steps: StepResult[];
  cancelledBy?: string;
}

export interface PlaybookActivities {
  assessBlast(i: { runId: string; playbook: string; trigger: Record<string, unknown> }): Promise<BlastRadius | null>;
  executeStep(i: { runId: string; playbook: string; step: { id: string; type: string; autonomy: string }; with: Record<string, unknown>; approvedBy?: string; prior: StepResult[] }): Promise<{ ok: boolean; summary: string; undo?: Record<string, unknown>; data?: Record<string, unknown>; proposed?: boolean }>;
  recordRun(i: { runId: string; playbook: string; type: 'PlaybookStepAwaitingApproval' | 'PlaybookStepDecided' | 'PlaybookRunFinished'; data: Record<string, unknown> }): Promise<void>;
}

/** Workflow id of the approval of a human step (decided with the ApprovalWorkflow's `decide` update). */
export const stepApprovalId = (runId: string, stepId: string) => `ApprovalWorkflow-${runId}-${stepId}`;
export const STEP_APPROVAL_REMINDER_MS = 4 * 3_600_000;
export const STEP_APPROVAL_EXPIRE_MS = 7 * 86_400_000;

export const cancelRunSignal = defineSignal<[{ by: string; reason?: string }]>('cancelRun');
export const playbookRunQuery = defineQuery<PlaybookRunState>('playbookRun');

const acts = proxyActivities<PlaybookActivities>({ startToCloseTimeout: '3 minutes', retry: { maximumAttempts: 5, initialInterval: '2 seconds' } });

export async function PlaybookRun(input: PlaybookRunInput): Promise<PlaybookRunState> {
  const s: PlaybookRunState = {
    runId: input.runId,
    playbook: input.playbook.id,
    version: input.playbook.version,
    state: 'running',
    trigger: input.trigger,
    blast: null,
    steps: input.playbook.steps.map((x) => ({ id: x.id, type: x.type, autonomy: x.autonomy, state: 'pending' })),
  };
  let cancelled: { by: string; reason?: string } | undefined;
  setHandler(playbookRunQuery, () => s);
  setHandler(cancelRunSignal, (c) => {
    cancelled ??= c;
  });
  const publish = (state: string) => upsertSearchAttributes([{ key: BSA.BusinessState, value: state }]);
  publish('running');

  if (input.playbook.assess.blast_radius === 'ontology') s.blast = await acts.assessBlast({ runId: input.runId, playbook: input.playbook.id, trigger: input.trigger.data });
  const ctx = () => ({
    trigger: input.trigger.data,
    blast: s.blast ?? { upstream: '', tools: [], actions: [], writeActions: [], classes: [], objects: [], workflows: [] },
    run: { id: input.runId, playbook: input.playbook.id, workflow: workflowInfo().workflowId },
    steps: Object.fromEntries(s.steps.map((x) => [x.id, x])),
  });

  for (const [i, def] of input.playbook.steps.entries()) {
    const st = s.steps[i]!;
    if (cancelled) break;
    let rendered: Record<string, unknown>;
    try {
      rendered = render(def.with, ctx()) as Record<string, unknown>;
    } catch (err) {
      Object.assign(st, { state: 'failed', error: (err as Error).message });
      continue;
    }
    let approvedBy: string | undefined;
    if (def.autonomy === 'human') {
      const child = await startChild(ApprovalWorkflow, {
        workflowId: stepApprovalId(input.runId, def.id),
        parentClosePolicy: ParentClosePolicy.TERMINATE,
        args: [
          {
            kind: 'playbook-step',
            subject: `${input.playbook.title ?? input.playbook.id}: ${def.id} (${def.type}, ${directionOf(def.type)})`,
            requestSeq: 0,
            action: `playbook_${def.type.replace(/\./g, '_')}`,
            args: rendered,
            caller: { workflow: workflowInfo().workflowId },
            reason: def.description ?? `step ${def.id} of run ${input.runId}`,
            objects: [],
            effect: { runId: input.runId, stepId: def.id, playbook: input.playbook.id },
            reminderMs: STEP_APPROVAL_REMINDER_MS,
            expireMs: STEP_APPROVAL_EXPIRE_MS,
          },
        ],
      });
      st.approvalWorkflowId = child.workflowId;
      // visible as waiting only once the approval exists (the inbox and the console decide through it)
      st.state = 'awaiting_approval';
      s.state = 'awaiting_approval';
      publish('awaiting_approval');
      await acts.recordRun({ runId: input.runId, playbook: input.playbook.id, type: 'PlaybookStepAwaitingApproval', data: { step: def.id, type: def.type, direction: directionOf(def.type), approval: child.workflowId } });
      const res = await Promise.race([child.result(), condition(() => !!cancelled).then(() => undefined)]);
      s.state = 'running';
      publish('running');
      if (cancelled || !res) {
        st.state = 'cancelled';
        break;
      }
      const d = res.decision;
      Object.assign(st, { decidedBy: d?.by, comment: d?.comment ?? (res.state === 'expired' ? 'the approval expired' : undefined) });
      await acts.recordRun({ runId: input.runId, playbook: input.playbook.id, type: 'PlaybookStepDecided', data: { step: def.id, decision: d?.decision ?? res.state, by: d?.by ?? null, comment: d?.comment ?? null } });
      if (!d || d.decision === 'reject') {
        st.state = 'skipped';
        continue;
      }
      approvedBy = d.by;
    }
    st.state = 'running';
    // a running step finishes even if the run is cancelled meanwhile (no half-applied tightening)
    const out = await CancellationScope.nonCancellable(() => acts.executeStep({ runId: input.runId, playbook: input.playbook.id, step: { id: def.id, type: def.type, autonomy: def.autonomy }, with: rendered, approvedBy, prior: s.steps.slice(0, i) }));
    Object.assign(st, { state: !out.ok ? 'failed' : out.proposed ? 'proposed' : 'done', summary: out.summary, error: out.ok ? undefined : out.summary, undo: out.undo, data: out.data, approvedBy, at: new Date().toISOString() });
  }
  if (cancelled) {
    s.state = 'cancelled';
    s.cancelledBy = cancelled.by;
    for (const st of s.steps) if (st.state === 'pending' || st.state === 'awaiting_approval') st.state = 'cancelled';
  } else s.state = s.steps.some((x) => x.state === 'failed') ? 'failed' : 'completed';
  publish(s.state);
  await acts.recordRun({ runId: input.runId, playbook: input.playbook.id, type: 'PlaybookRunFinished', data: { state: s.state, steps: s.steps.map((x) => ({ id: x.id, state: x.state, summary: x.summary ?? null })), cancelledBy: s.cancelledBy ?? null, recordIncident: input.playbook.learn.record_incident } });
  return s;
}
