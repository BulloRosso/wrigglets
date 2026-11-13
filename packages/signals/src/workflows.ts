// Entry point for the workflow bundle: only workflow functions are exported here.
import {
  ParentClosePolicy,
  allHandlersFinished,
  condition,
  log,
  proxyActivities,
  setHandler,
  startChild,
  upsertSearchAttributes,
  workflowInfo,
} from '@temporalio/workflow';
import {
  OPEN_SIGNAL_STATES,
  SIGNALS_LIMITS,
  type ExpectationInput,
  type ExpectationResolveInput,
  type ExpectationState,
  type ObservationRecord,
  type SignalState,
} from '@cw/shared';
import { SA } from '@cw/shared/search-attributes';
import { SIGNALS_ACTIVITY_ERRORS, type ObservationWorkflowInput, type SignalsActivities } from './activity-types.js';
import { dismissExpectationUpdate, editExpectationUpdate, expectationStateQuery, fulfillExpectationUpdate, observationResultQuery } from './messages.js';
import { clampDueAt, expectationIdFor } from './rules.js';

const DAY = 86_400_000;
const EXCERPT = 400;

const quick = proxyActivities<SignalsActivities>({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 5 } });
const model = proxyActivities<SignalsActivities>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 3, initialInterval: '20 seconds', nonRetryableErrorTypes: [SIGNALS_ACTIVITY_ERRORS.aiNotConfigured] },
});
// A paused agent makes raiseSignal fail with AgentHalted; it is retried (up to ~2 days) until the agent runs again.
const signaller = proxyActivities<SignalsActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 300, initialInterval: '30 seconds', backoffCoefficient: 2, maximumInterval: '10 minutes' },
});

const errorText = (err: unknown) => (err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)).slice(0, 500);

/* ===================================================================================== observationWorkflow */

/**
 * One observation: interpret it (0..n events), close the expectations it fulfils and start one expectationWorkflow per
 * new expectation. The workflow id is derived from the observation (source + ref or body hash), so a mail that is
 * delivered twice is processed once.
 */
export async function observationWorkflow(input: ObservationWorkflowInput): Promise<ObservationRecord> {
  const id = workflowInfo().workflowId;
  const obs = input.observation;
  const record: ObservationRecord = {
    id,
    at: obs.receivedAt,
    source: obs.source,
    ref: obs.ref,
    subject: obs.subject,
    from: obs.from,
    excerpt: obs.body.slice(0, EXCERPT),
    events: [],
    fulfilled: [],
    created: [],
  };
  setHandler(observationResultQuery, () => record);

  try {
    const open = await quick.listOpenExpectations({});
    const result = input.preInterpreted ?? (await model.interpretObservation({ observationId: id, observation: obs, open }));
    record.events = result.events;
    record.note = result.note;

    // 1. Close what this observation fulfils (only expectations that are really open, above the confidence threshold)
    const openIds = new Set(open.map((o) => o.id));
    for (const f of result.fulfills) {
      if (f.confidence < input.settings.fulfilThreshold || !openIds.has(f.expectationId)) continue;
      openIds.delete(f.expectationId);
      const ok = await quick.resolveExpectation({ expectationId: f.expectationId, reason: f.reason, observationId: id, by: `signals:${id}` });
      if (ok) record.fulfilled.push({ expectationId: f.expectationId, reason: f.reason });
    }

    // 2. Start one workflow per new expectation (bounded by the per-agent limit and the horizon)
    const room = Math.max(0, SIGNALS_LIMITS.maxOpen - open.length + record.fulfilled.length);
    const now = Date.now();
    const skipped: string[] = [];
    for (const [i, e] of result.expectations.entries()) {
      if (record.created.length >= room) {
        skipped.push(`"${e.title}": limit of ${SIGNALS_LIMITS.maxOpen} open expectations reached`);
        continue;
      }
      const dueAt = clampDueAt(e.dueAt, now);
      if (!dueAt) {
        skipped.push(`"${e.title}": due date out of range`);
        continue;
      }
      const action = e.action ?? input.settings.defaultAction;
      const expectation: ExpectationInput = {
        agentId: input.agentId,
        title: e.title,
        description: e.description,
        matchHint: e.matchHint,
        dueAt,
        action,
        taskTitle: e.taskTitle,
        taskInstructions: e.taskInstructions,
        graceDays: input.settings.graceDays,
        source: { observationId: id, kind: obs.source, subject: obs.subject, events: result.events.map((ev) => ev.summary).slice(0, 5) },
        createdBy: input.by,
      };
      const childId = expectationIdFor(id, i);
      await startChild(expectationWorkflow, {
        workflowId: childId,
        args: [expectation],
        parentClosePolicy: ParentClosePolicy.ABANDON,
        typedSearchAttributes: [
          { key: SA.AgentId, value: input.agentId },
          { key: SA.SignalState, value: 'open' },
          { key: SA.SignalDue, value: new Date(dueAt) },
          { key: SA.SignalSource, value: obs.source },
          { key: SA.TaskTitle, value: e.title },
        ],
        staticSummary: e.title.slice(0, 200),
      });
      record.created.push(childId);
    }
    if (skipped.length) record.skipped = skipped.join('; ').slice(0, 1000);
  } catch (err) {
    record.error = errorText(err);
    log.warn('observation could not be processed', { error: record.error });
  }
  await quick.recordObservation(record);
  return record;
}

/* ===================================================================================== expectationWorkflow */

/**
 * One open loop: waits until it is fulfilled, dismissed or due. When due it raises a signal (notify people or start a
 * follow-up task that a person must approve) and stays open for a late fulfilment until the grace period ends.
 * A new due date (edit) re-arms the timer, also after a signal ("snooze").
 */
export async function expectationWorkflow(input: ExpectationInput): Promise<ExpectationState> {
  const st: ExpectationState = {
    ...input,
    id: workflowInfo().workflowId,
    state: 'open',
    createdAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), kind: 'created', by: input.createdBy, text: `due ${input.dueAt}` }],
  };
  let rearm = false;

  const setState = (s: SignalState) => {
    st.state = s;
    upsertSearchAttributes([{ key: SA.SignalState, value: s }]);
  };
  const isOpen = () => OPEN_SIGNAL_STATES.includes(st.state);
  const assertOpen = () => {
    if (!isOpen()) throw new Error(`The expectation is already ${st.state}`);
  };
  const close = (s: 'fulfilled' | 'dismissed', r: ExpectationResolveInput) => {
    const at = new Date().toISOString();
    st.resolution = { at, by: r.by, reason: r.reason, observationId: r.observationId };
    st.history.push({ at, kind: s, by: r.by, text: r.reason });
    setState(s);
  };

  setHandler(expectationStateQuery, () => st);
  setHandler(
    editExpectationUpdate,
    (e) => {
      const { by, ...changes } = e;
      const at = new Date().toISOString();
      const changed = Object.entries(changes).filter(([, v]) => v !== undefined);
      Object.assign(st, Object.fromEntries(changed));
      if (changes.title) upsertSearchAttributes([{ key: SA.TaskTitle, value: changes.title }]);
      if (changes.dueAt) {
        st.dueAt = clampDueAt(changes.dueAt, Date.now())!;
        upsertSearchAttributes([{ key: SA.SignalDue, value: new Date(st.dueAt) }]);
        if (st.state === 'signalled') setState('open');
        rearm = true;
      }
      st.history.push({ at, kind: 'edited', by, text: changed.map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(', ') });
      return st;
    },
    {
      validator: (e) => {
        assertOpen();
        if (e.dueAt && !clampDueAt(e.dueAt, Date.now())) throw new Error(`The due date must be within ${SIGNALS_LIMITS.maxHorizonDays} days`);
      },
    },
  );
  setHandler(
    fulfillExpectationUpdate,
    (r) => {
      close('fulfilled', r);
      return st;
    },
    { validator: (_r: ExpectationResolveInput) => assertOpen() },
  );
  setHandler(
    dismissExpectationUpdate,
    (r) => {
      close('dismissed', r);
      return st;
    },
    {
      validator: (r) => {
        assertOpen();
        if (!r.reason?.trim()) throw new Error('A reason is required to dismiss an expectation');
      },
    },
  );

  async function raise() {
    const at = new Date().toISOString();
    st.signal = { at, action: st.action };
    st.history.push({ at, kind: 'signalled', text: st.action === 'notify' ? 'people notified' : 'follow-up task proposed' });
    setState('signalled');
    try {
      const r = await signaller.raiseSignal({ expectation: { ...st, history: st.history.slice(-5) } });
      st.signal.taskId = r.taskId;
    } catch (err) {
      st.signal.error = errorText(err);
      log.warn('signal could not be raised', { error: st.signal.error });
    }
  }

  while (isOpen()) {
    rearm = false;
    if (st.state === 'open') {
      const wait = Date.parse(st.dueAt) - Date.now();
      const changed = wait > 0 && (await condition(() => st.state !== 'open' || rearm, wait));
      if (changed) continue;
      await raise();
    } else {
      // signalled: a late fulfilment is still welcome until the grace period ends
      const end = Date.parse(st.signal!.at) + st.graceDays * DAY;
      const wait = end - Date.now();
      const changed = wait > 0 && (await condition(() => st.state !== 'signalled' || rearm, wait));
      if (changed) continue;
      st.history.push({ at: new Date().toISOString(), kind: 'expired', text: `no fulfilment within ${st.graceDays} days after the signal` });
      setState('expired');
    }
  }
  await condition(allHandlersFinished);
  return st;
}
