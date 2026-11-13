import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { WorkflowUpdateFailedError } from '@temporalio/client';
import type { ExpectationInput, ExpectationState, InterpretResult, ObservationRecord } from '@cw/shared';
import { SA } from '@cw/shared/search-attributes';
import type { ObservationWorkflowInput, OpenExpectationSummary, SignalsActivities } from '../src/activity-types.js';
import { dismissExpectationUpdate, editExpectationUpdate, expectationStateQuery, fulfillExpectationUpdate } from '../src/messages.js';
import { clampDueAt, expectationIdFor } from '../src/rules.js';

/*
 * Workflow tests against a local Temporal dev server with mocked activities. Due dates are a few seconds ahead, so no
 * time skipping is needed (same approach as packages/workflows).
 */

const AGENT = 'testagent';
const QUEUE = 'agent-testagent';

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
let nextInterpretation: InterpretResult = { events: [], fulfills: [], expectations: [] };
let open: OpenExpectationSummary[] = [];
let haltRaises = 0;
const raised: ExpectationState[] = [];
const resolved: string[] = [];
const recorded: ObservationRecord[] = [];

const activities: SignalsActivities = {
  async listOpenExpectations() {
    return open;
  },
  async interpretObservation() {
    return nextInterpretation;
  },
  async resolveExpectation(i) {
    resolved.push(i.expectationId);
    await env.client.workflow.getHandle(i.expectationId).executeUpdate(fulfillExpectationUpdate, { args: [{ by: i.by, reason: i.reason, observationId: i.observationId }] });
    return true;
  },
  async recordObservation(r) {
    recorded.push(r);
  },
  async raiseSignal({ expectation }) {
    if (haltRaises > 0) {
      haltRaises -= 1;
      throw ApplicationFailure.retryable('agent is paused', 'AgentHalted');
    }
    raised.push(expectation);
    return expectation.action === 'propose_task' ? { taskId: `task-sig-${expectation.id}` } : { notified: 2 };
  },
};

const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
let seq = 0;

function expectation(over: Partial<ExpectationInput> = {}): ExpectationInput {
  return {
    agentId: AGENT,
    title: 'Invoice from Hotel Nordlicht arrives',
    description: 'Stay 18–20 Nov; the invoice is sent after departure.',
    matchHint: 'Mail from Hotel Nordlicht with an invoice',
    dueAt: inSeconds(3),
    action: 'propose_task',
    graceDays: 30,
    source: { observationId: 'sig-obs-test', kind: 'api', events: ['Hotel booking confirmed'] },
    createdBy: 'test',
    ...over,
  };
}

async function startExpectation(over: Partial<ExpectationInput> = {}) {
  const id = `sig-exp-test-${Date.now()}-${++seq}`;
  const handle = await env.client.workflow.start('expectationWorkflow', {
    workflowId: id,
    taskQueue: QUEUE,
    args: [expectation(over)],
    typedSearchAttributes: [{ key: SA.AgentId, value: AGENT }, { key: SA.SignalState, value: 'open' }],
  });
  return { id, handle };
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(v).slice(0, 400)}`);
    await sleep(200);
  }
}

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal({ server: { searchAttributes: Object.values(SA) } });
  const bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
    logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } as never,
  });
  worker = await Worker.create({ connection: env.nativeConnection, taskQueue: QUEUE, workflowBundle: bundle, activities });
  workerRun = worker.run();
}, 180_000);

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => undefined);
  await env?.teardown();
}, 60_000);

beforeEach(() => {
  raised.length = 0;
  resolved.length = 0;
  recorded.length = 0;
  open = [];
  haltRaises = 0;
});

describe('rules', () => {
  it('clamps due dates: past → now, beyond the horizon → refused', () => {
    const now = Date.parse('2026-11-13T10:00:00Z');
    expect(clampDueAt('2026-11-01T00:00:00Z', now)).toBe('2026-11-13T10:00:00.000Z');
    expect(clampDueAt('2026-11-25T00:00:00+01:00', now)).toBe('2026-11-24T23:00:00.000Z');
    expect(clampDueAt('2028-01-01T00:00:00Z', now)).toBeUndefined();
    expect(clampDueAt('not a date', now)).toBeUndefined();
  });
  it('derives expectation ids from the observation id', () => {
    expect(expectationIdFor('sig-obs-anna-abc123', 0)).toBe('sig-exp-anna-abc123-1');
  });
});

describe('expectationWorkflow', () => {
  it('signals when due and expires after the grace period without fulfilment', async () => {
    // grace 0 days: expires right after the signal
    const { id, handle } = await startExpectation({ dueAt: inSeconds(2), graceDays: 0 });
    const st = (await handle.result()) as ExpectationState;
    expect(st.state).toBe('expired');
    expect(st.signal?.taskId).toBe(`task-sig-${id}`);
    expect(raised.map((r) => r.id)).toEqual([id]);
    expect(st.history.map((h) => h.kind)).toEqual(['created', 'signalled', 'expired']);
  });

  it('a fulfilment before the due date closes it without a signal', async () => {
    const { handle } = await startExpectation({ dueAt: inSeconds(60) });
    const st = await handle.executeUpdate(fulfillExpectationUpdate, { args: [{ by: 'anna@example.com', reason: 'Invoice received' }] });
    expect(st.state).toBe('fulfilled');
    const done = (await handle.result()) as ExpectationState;
    expect(done.resolution).toMatchObject({ by: 'anna@example.com', reason: 'Invoice received' });
    expect(raised).toHaveLength(0);
  });

  it('a later due date re-arms the timer; an earlier one fires sooner', async () => {
    const { handle } = await startExpectation({ dueAt: inSeconds(2) });
    await handle.executeUpdate(editExpectationUpdate, { args: [{ by: 'ben@example.com', dueAt: inSeconds(120) }] });
    await sleep(3500);
    expect(raised).toHaveLength(0);
    await handle.executeUpdate(editExpectationUpdate, { args: [{ by: 'ben@example.com', dueAt: inSeconds(1), action: 'notify' }] });
    const st = await waitFor(() => handle.query(expectationStateQuery), (s) => s.state === 'signalled');
    expect(st.signal?.action).toBe('notify');
    expect(raised).toHaveLength(1);
    await handle.executeUpdate(dismissExpectationUpdate, { args: [{ by: 'ben@example.com', reason: 'Paid by the company card, no invoice needed' }] });
    expect(((await handle.result()) as ExpectationState).state).toBe('dismissed');
  });

  it('snoozing a signalled expectation re-opens it', async () => {
    const { handle } = await startExpectation({ dueAt: inSeconds(1), action: 'notify' });
    await waitFor(() => handle.query(expectationStateQuery), (s) => s.state === 'signalled');
    const st = await handle.executeUpdate(editExpectationUpdate, { args: [{ by: 'ben@example.com', dueAt: inSeconds(90) }] });
    expect(st.state).toBe('open');
    await handle.executeUpdate(fulfillExpectationUpdate, { args: [{ by: 'ben@example.com', reason: 'arrived' }] });
    expect(((await handle.result()) as ExpectationState).state).toBe('fulfilled');
  });

  it('refuses a dismissal without a reason, updates on a closed expectation and far-away due dates', async () => {
    const { handle } = await startExpectation({ dueAt: inSeconds(60) });
    await expect(handle.executeUpdate(dismissExpectationUpdate, { args: [{ by: 'x', reason: ' ' }] })).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
    await expect(handle.executeUpdate(editExpectationUpdate, { args: [{ by: 'x', dueAt: '2099-01-01T00:00:00Z' }] })).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
    await handle.executeUpdate(dismissExpectationUpdate, { args: [{ by: 'x', reason: 'not needed' }] });
    // the workflow has completed: the update is refused (the API answers 409 for closed expectations)
    await expect(handle.executeUpdate(fulfillExpectationUpdate, { args: [{ by: 'x', reason: 'late' }] })).rejects.toThrow();
  });

  it('waits while the agent is paused (raiseSignal retried until it succeeds)', async () => {
    haltRaises = 1;
    const { handle } = await startExpectation({ dueAt: inSeconds(1), graceDays: 0 });
    const st = (await handle.result()) as ExpectationState;
    expect(st.signal?.taskId).toBeDefined();
    expect(st.signal?.error).toBeUndefined();
  }, 90_000);
});

describe('observationWorkflow', () => {
  const settings: ObservationWorkflowInput['settings'] = { fulfilThreshold: 0.7, defaultAction: 'propose_task', graceDays: 30 };
  const observation = (body: string): ObservationWorkflowInput['observation'] => ({ source: 'api', subject: 'Test', body, receivedAt: new Date().toISOString() });

  it('zero events is a valid result', async () => {
    nextInterpretation = { events: [], fulfills: [], expectations: [], note: 'Newsletter, nothing follows' };
    const r = (await env.client.workflow.execute('observationWorkflow', {
      workflowId: `sig-obs-test-news-${Date.now()}`,
      taskQueue: QUEUE,
      args: [{ agentId: AGENT, observation: observation('Our ramen of the week …'), by: 'test', settings } satisfies ObservationWorkflowInput],
    })) as ObservationRecord;
    expect(r).toMatchObject({ events: [], created: [], fulfilled: [], note: 'Newsletter, nothing follows' });
    expect(recorded).toHaveLength(1);
  });

  it('creates expectations, skips out-of-range ones and fulfils matching open ones above the threshold', async () => {
    const { id: openId } = await startExpectation({ dueAt: inSeconds(120) });
    const { id: weakId } = await startExpectation({ dueAt: inSeconds(120) });
    open = [
      { id: openId, title: 'Invoice arrives', description: '', matchHint: '', dueAt: inSeconds(120), state: 'open' },
      { id: weakId, title: 'Other', description: '', matchHint: '', dueAt: inSeconds(120), state: 'open' },
    ];
    nextInterpretation = {
      events: [{ type: 'invoice_received', summary: 'Hotel Nordlicht sent the invoice' }],
      fulfills: [
        { expectationId: openId, confidence: 0.95, reason: 'The invoice arrived' },
        { expectationId: weakId, confidence: 0.4, reason: 'maybe' },
        { expectationId: 'sig-exp-unknown-1', confidence: 1, reason: 'not open' },
      ],
      expectations: [
        { title: 'Invoice is paid', description: '', matchHint: 'payment confirmation', dueAt: inSeconds(300), action: 'notify' },
        { title: 'Far away', description: '', matchHint: '', dueAt: '2099-01-01T00:00:00Z' },
      ],
    };
    const obsId = `sig-obs-test-inv-${Date.now()}`;
    const r = (await env.client.workflow.execute('observationWorkflow', {
      workflowId: obsId,
      taskQueue: QUEUE,
      args: [{ agentId: AGENT, observation: observation('Invoice no. 4711'), by: 'test', settings } satisfies ObservationWorkflowInput],
    })) as ObservationRecord;
    expect(r.fulfilled.map((f) => f.expectationId)).toEqual([openId]);
    expect(resolved).toEqual([openId]);
    expect(r.created).toEqual([expectationIdFor(obsId, 0)]);
    expect(r.skipped).toMatch(/Far away/);
    const child = await env.client.workflow.getHandle(r.created[0]!).query(expectationStateQuery);
    expect(child).toMatchObject({ state: 'open', action: 'notify', title: 'Invoice is paid', source: { observationId: obsId, events: ['Hotel Nordlicht sent the invoice'] } });
    expect((await env.client.workflow.getHandle(openId).query(expectationStateQuery)).state).toBe('fulfilled');
    expect((await env.client.workflow.getHandle(weakId).query(expectationStateQuery)).state).toBe('open');
    // the default action applies when the model gives none
    await env.client.workflow.getHandle(r.created[0]!).executeUpdate(dismissExpectationUpdate, { args: [{ by: 'x', reason: 'test cleanup' }] });
  });

  it('uses a pre-interpreted (reviewed) result without calling the model', async () => {
    nextInterpretation = { events: [{ type: 'should_not', summary: 'model was called' }], fulfills: [], expectations: [] };
    const r = (await env.client.workflow.execute('observationWorkflow', {
      workflowId: `sig-obs-test-pre-${Date.now()}`,
      taskQueue: QUEUE,
      args: [
        {
          agentId: AGENT,
          observation: observation('Customer promises an answer by Friday'),
          by: 'anna@example.com',
          settings,
          preInterpreted: { events: [{ type: 'promise', summary: 'Customer will answer by Friday' }], fulfills: [], expectations: [] },
        } satisfies ObservationWorkflowInput,
      ],
    })) as ObservationRecord;
    expect(r.events.map((e) => e.type)).toEqual(['promise']);
  });
});
