import { CancellationScope, condition, defineQuery, defineSignal, defineUpdate, proxyActivities, setHandler, upsertSearchAttributes, workflowInfo } from '@temporalio/workflow';
import { directionOf, render, type BlastRadius, type Playbook } from '@cw/playbooks';
import { BSA } from './common.js';

/*
 * PlaybookRun (ADR-0047): one run of a playbook, durable across restarts. Steps run in order:
 *   auto    → executed now
 *   propose → executed in "propose" mode: it creates something a person decides later (agent task, config proposal);
 *             the run does not wait
 *   human   → the run waits for a person's decision (update `decideStep`); approve → executed with approvedBy
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

export interface StepDecision {
  stepId: string;
  decision: 'approve' | 'reject';
  by: string;
  comment?: string;
}

export const decideStepUpdate = defineUpdate<PlaybookRunState, [StepDecision]>('decideStep');
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
  const decisions = new Map<string, StepDecision>();
  let cancelled: { by: string; reason?: string } | undefined;
  setHandler(playbookRunQuery, () => s);
  setHandler(cancelRunSignal, (c) => {
    cancelled ??= c;
  });
  setHandler(
    decideStepUpdate,
    (d) => {
      decisions.set(d.stepId, d);
      return s;
    },
    {
      validator: (d) => {
        const st = s.steps.find((x) => x.id === d.stepId);
        if (!st) throw new Error(`unknown step ${d.stepId}`);
        if (st.state !== 'awaiting_approval') throw new Error(`step ${d.stepId} is ${st.state}, not awaiting approval`);
        if (decisions.has(d.stepId)) throw new Error(`step ${d.stepId} was already decided`);
        if (!d.by) throw new Error('the deciding person is required');
        if (d.decision !== 'approve' && d.decision !== 'reject') throw new Error('decision must be approve or reject');
      },
    },
  );
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
      st.state = 'awaiting_approval';
      s.state = 'awaiting_approval';
      publish('awaiting_approval');
      await acts.recordRun({ runId: input.runId, playbook: input.playbook.id, type: 'PlaybookStepAwaitingApproval', data: { step: def.id, type: def.type, direction: directionOf(def.type) } });
      await condition(() => decisions.has(def.id) || !!cancelled);
      s.state = 'running';
      publish('running');
      if (cancelled) {
        st.state = 'cancelled';
        break;
      }
      const d = decisions.get(def.id)!;
      Object.assign(st, { decidedBy: d.by, comment: d.comment });
      await acts.recordRun({ runId: input.runId, playbook: input.playbook.id, type: 'PlaybookStepDecided', data: { step: def.id, decision: d.decision, by: d.by, comment: d.comment ?? null } });
      if (d.decision === 'reject') {
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
