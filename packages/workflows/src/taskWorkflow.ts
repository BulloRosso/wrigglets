import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  condition,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  upsertSearchAttributes,
  sleep,
  workflowInfo,
  type ActivityOptions,
} from '@temporalio/workflow';
import {
  AGENT_ROLES,
  isTerminalStatus,
  parseDuration,
  toIdentity,
  workspacePaths,
  type DecisionInput,
  type Identity,
  type StepKind,
  type TaskInput,
  type TaskResult,
  type TaskSettings,
  type TaskState,
  type TaskStatus,
} from '@cw/shared';
import { SA } from '@cw/shared/search-attributes';
import {
  ACTIVITY_ERRORS,
  type AgentActivities,
  type BudgetExceededDetails,
  type CommitMeta,
  type NotificationKind,
  type RunAgentStepResult,
  type VerifyResult,
} from './activity-types.js';
import { createWorkspaceLock } from './lock.js';
import { cancelUpdate, commentUpdate, decideUpdate, taskStateQuery } from './messages.js';
import { fixPrompt, integratePrompt, planPrompt, runPrompt } from './prompts.js';

/* ----------------------------------------------------------------- activity options (spec §7.6) */

const STEP_OPTIONS: ActivityOptions = {
  startToCloseTimeout: '60 minutes',
  heartbeatTimeout: '2 minutes',
  // On cancellation wait until the activity has aborted the harness session, so that no
  // harness turn keeps writing to the workspace after the lock was released.
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    maximumAttempts: 3,
    initialInterval: '30 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      ACTIVITY_ERRORS.budgetExceeded,
      ACTIVITY_ERRORS.permissionDenied,
      ACTIVITY_ERRORS.harnessConfig,
    ],
  },
};
const VERIFY_OPTIONS: ActivityOptions = { startToCloseTimeout: '10 minutes', retry: { maximumAttempts: 2 } };
const UPLOAD_OPTIONS: ActivityOptions = { startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } };
const FINALIZE_OPTIONS: ActivityOptions = { startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 5 } };
const NOTIFY_OPTIONS: ActivityOptions = { startToCloseTimeout: '1 minute', retry: { maximumAttempts: 5 } };

const steps = proxyActivities<AgentActivities>(STEP_OPTIONS);
const verifier = proxyActivities<AgentActivities>(VERIFY_OPTIONS);
const uploads = proxyActivities<AgentActivities>(UPLOAD_OPTIONS);
const finalizer = proxyActivities<AgentActivities>(FINALIZE_OPTIONS);
const notifier = proxyActivities<AgentActivities>(NOTIFY_OPTIONS);
const delegationChecker = proxyActivities<AgentActivities>({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 5 } });
const DELEGATION_POLL = '30 seconds';
const MAX_DELEGATION_ROUNDS = 3;

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  maxFixRounds: 2,
  approvalReminderAfter: '4h',
  approvalExpireAfter: '7d',
  approverPolicy: 'approver-or-requester',
  maxRevisions: 3,
};

const STEP_LABEL: Record<StepKind, string> = { plan: 'Plan', run: 'Run', fix: 'Fix' };
const MAX_NOTES = 200;

/** Workflow-internal control-flow errors (never leave the workflow). */
class BudgetExceeded extends Error {}
class ApprovalExpired extends Error {}

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function taskWorkflow(input: TaskInput): Promise<TaskResult> {
  const info = workflowInfo();
  // The workflow id IS the task id (also for schedule-started tasks, whose ids get a timestamp suffix).
  const taskId = info.workflowId;
  const settings: TaskSettings = { ...DEFAULT_TASK_SETTINGS, ...input.settings };
  const owner: Identity = input.trigger.kind === 'schedule' ? input.trigger.owner : input.requestedBy;

  const state: TaskState = {
    taskId,
    agentId: input.agentId,
    title: input.title,
    instructions: input.instructions,
    type: input.type,
    approval: input.approval,
    status: 'queued',
    lock: 'none',
    requestedBy: input.requestedBy,
    trigger: input.trigger,
    createdAt: new Date().toISOString(),
    approvedBy: [],
    decisions: [],
    revisions: 0,
    steps: [],
    usage: { tokens: 0, maxTokens: input.budget.maxTokens },
    notes: [],
  };
  const counters: Record<StepKind, number> = { plan: 0, run: 0, fix: 0 };
  let pendingDecision: DecisionInput | undefined;

  let statusBeforeSuspend: TaskStatus | undefined;
  const lock = createWorkspaceLock(
    input.agentId,
    taskId,
    (s) => {
      state.lock = s;
    },
    // Kill switch: the agent was paused while this task held the lock (ADR-0022).
    (suspended, reason) => {
      if (suspended) {
        statusBeforeSuspend ??= state.status;
        state.suspended = { reason, at: new Date().toISOString() };
        setStatus('suspended');
      } else if (statusBeforeSuspend) {
        state.suspended = undefined;
        setStatus(statusBeforeSuspend);
        statusBeforeSuspend = undefined;
      }
    },
  );
  const mainScope = new CancellationScope();

  const meta = (): CommitMeta => ({
    requestedBy: owner.upn,
    approvedBy: [...state.approvedBy],
    trigger: input.trigger.kind,
  });

  function setStatus(status: TaskStatus) {
    if (state.status === status) return;
    state.status = status;
    upsertSearchAttributes([{ key: SA.TaskStatus, value: status }]);
  }

  /* --------------------------------------------------------------- message handlers */

  setHandler(taskStateQuery, () => state);

  setHandler(
    decideUpdate,
    (d) => {
      const by = toIdentity(d.by);
      state.decisions.push({ decision: d.decision, by, comment: d.comment, at: new Date().toISOString(), kind: state.awaiting ?? 'plan' });
      if (d.decision === 'approve' && !state.approvedBy.includes(by.upn)) {
        state.approvedBy.push(by.upn);
        upsertSearchAttributes([{ key: SA.ApprovedBy, value: [...state.approvedBy] }]);
      }
      pendingDecision = d;
      return state;
    },
    {
      validator: (d) => {
        if (state.status !== 'awaiting_approval' || pendingDecision) {
          throw new Error(`Task is not awaiting approval (status: ${state.status})`);
        }
        if (d.decision !== 'approve' && !d.comment?.trim()) {
          throw new Error('A comment is required to reject or request changes');
        }
        if (d.decision === 'revise' && state.awaiting === 'plan' && state.revisions >= settings.maxRevisions) {
          throw new Error(`The plan was already revised ${settings.maxRevisions} times; approve or reject it`);
        }
        const isRequester = d.by.upn === owner.upn;
        const isApprover = d.by.roles.includes(AGENT_ROLES.approver);
        const allowed =
          settings.approverPolicy === 'approver-only'
            ? isApprover
            : settings.approverPolicy === 'requester-only'
              ? isRequester
              : isApprover || isRequester;
        if (!allowed) throw new Error('You are not allowed to decide on this task');
      },
    },
  );

  setHandler(
    commentUpdate,
    (c) => {
      state.notes.push({ by: toIdentity(c.by), text: c.text, at: new Date().toISOString() });
      if (state.notes.length > MAX_NOTES) state.notes.splice(0, state.notes.length - MAX_NOTES);
      return state;
    },
    {
      validator: (c) => {
        if (!c.text?.trim() || c.text.length > 4000) throw new Error('Comment must be 1–4000 characters');
      },
    },
  );

  setHandler(
    cancelUpdate,
    (c) => {
      state.cancelRequested = { by: toIdentity(c.by), reason: c.reason, at: new Date().toISOString() };
      mainScope.cancel();
      return state;
    },
    {
      validator: (_c) => {
        if (isTerminalStatus(state.status)) throw new Error(`Task already ${state.status}`);
        if (state.cancelRequested) throw new Error('Cancellation already requested');
      },
    },
  );

  /* --------------------------------------------------------------- helpers */

  async function notify(kind: NotificationKind, text?: string) {
    try {
      await notifier.notify({ to: [owner], kind, taskId, title: input.title, text });
    } catch (err) {
      // Notification failures never fail the task (spec §7.6).
      log.warn('notification failed', { kind, error: String(err) });
    }
  }

  async function step(kind: StepKind, prompt: string): Promise<RunAgentStepResult> {
    const remaining = state.usage.maxTokens - state.usage.tokens;
    if (remaining < state.usage.maxTokens * 0.05) throw new BudgetExceeded();
    counters[kind] += 1;
    const stepId = `${taskId}:${kind}:${counters[kind]}`;
    const summary = `${STEP_LABEL[kind]} #${counters[kind]} · ${short(input.title)}`;
    const startedAt = new Date().toISOString();
    let result: RunAgentStepResult;
    try {
      result = await steps.runAgentStep.executeWithOptions({ ...STEP_OPTIONS, summary }, [
        {
          taskId,
          stepId,
          kind,
          taskType: input.type,
          summary,
          prompt,
          sessionId: state.sessionId,
          budgetRemaining: remaining,
          requestedBy: owner,
          context: {
            title: input.title,
            instructions: input.instructions,
            planPath: state.plan?.path,
            previousSummaries: state.steps.map((s) => workspacePaths.summary(s.stepId)),
          },
          meta: meta(),
        },
      ]);
    } catch (err) {
      if (
        err instanceof ActivityFailure &&
        err.cause instanceof ApplicationFailure &&
        err.cause.type === ACTIVITY_ERRORS.budgetExceeded
      ) {
        const d = err.cause.details?.[0] as BudgetExceededDetails | undefined;
        if (d) {
          state.usage.tokens += d.tokens;
          state.steps.push({ stepId, kind, summary: d.summary, commit: d.commit, startedAt, endedAt: new Date().toISOString(), tokens: d.tokens, artifacts: [], filesTouched: [] });
        }
        // the activity explains why (e.g. the agent's 30-day spend limit in USD, ADR-0029)
        throw new BudgetExceeded(err.cause.message);
      }
      throw err;
    }
    for (const d of result.delegations ?? []) {
      state.delegations ??= [];
      if (!state.delegations.some((x) => x.agentId === d.agentId && x.taskId === d.taskId)) {
        state.delegations.push({ ...d, state: 'submitted', terminal: false, at: new Date().toISOString() });
      }
    }
    state.sessionId = result.sessionId;
    state.usage.tokens += result.tokens;
    if (result.cost !== undefined) state.usage.cost = (state.usage.cost ?? 0) + result.cost;
    state.steps.push({
      stepId,
      kind,
      summary: result.summary,
      commit: result.commit,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      tokens: result.tokens,
      artifacts: result.artifacts,
      filesTouched: result.filesTouched,
    });
    return result;
  }

  const delegationResults = new Map<string, string>();

  /**
   * Waits — without holding the workspace lock — until all tasks delegated to other agents (A2A) are
   * finished (ADR-0023). Returns true if there were delegations to wait for.
   */
  async function awaitDelegations(): Promise<boolean> {
    const pending = () => (state.delegations ?? []).filter((d) => !d.terminal);
    if (!pending().length) return false;
    const previous = state.status;
    setStatus('awaiting_delegations');
    const deadline = Date.now() + parseDuration(settings.approvalExpireAfter);
    while (pending().length) {
      const statuses = await delegationChecker.checkDelegations({ delegations: pending().map(({ agentId, taskId }) => ({ agentId, taskId })) });
      for (const st of statuses) {
        const d = state.delegations!.find((x) => x.agentId === st.agentId && x.taskId === st.taskId);
        if (!d) continue;
        Object.assign(d, { state: st.state, terminal: st.terminal, summary: st.summary, at: new Date().toISOString() });
        if (st.terminal) delegationResults.set(`${st.agentId}/${st.taskId}`, st.result ?? st.summary ?? '(no result)');
      }
      if (!pending().length) break;
      if (Date.now() > deadline) throw ApplicationFailure.nonRetryable('Delegated tasks did not finish in time', 'DelegationTimeout');
      await sleep(DELEGATION_POLL);
    }
    setStatus(previous);
    return true;
  }

  /** Runs a step; if it delegated work, waits for the results and integrates them in a follow-up step. */
  async function stepWithDelegations(kind: StepKind, prompt: string) {
    await lock.withWorkspace(() => step(kind, prompt));
    for (let round = 0; round < MAX_DELEGATION_ROUNDS && (await awaitDelegations()); round++) {
      const done = (state.delegations ?? []).filter((d) => d.terminal && delegationResults.has(`${d.agentId}/${d.taskId}`));
      const results = done.map((d) => ({ agentId: d.agentId, taskId: d.taskId, state: d.state, result: delegationResults.get(`${d.agentId}/${d.taskId}`)! }));
      for (const d of done) delegationResults.delete(`${d.agentId}/${d.taskId}`);
      await lock.withWorkspace(() => step('run', integratePrompt(taskId, input, results)));
    }
  }

  async function awaitDecision(kind: 'plan' | 'deviation'): Promise<DecisionInput> {
    pendingDecision = undefined;
    state.awaiting = kind;
    setStatus('awaiting_approval');
    await notify('approval_requested', kind === 'plan' ? 'A plan is waiting for your approval.' : 'Verification flagged deviations.');
    const remindAfter = parseDuration(settings.approvalReminderAfter);
    const expireAfter = parseDuration(settings.approvalExpireAfter);
    let decided = await condition(() => !!pendingDecision, remindAfter, { summary: 'approval reminder' });
    if (!decided) {
      await notify('approval_reminder', 'Reminder: approval still pending.');
      decided = await condition(() => !!pendingDecision, Math.max(expireAfter - remindAfter, 1000), {
        summary: 'approval expiry',
      });
    }
    if (!decided) throw new ApprovalExpired();
    const decision = pendingDecision!;
    pendingDecision = undefined;
    state.awaiting = undefined;
    return decision;
  }

  async function finalize(outcome: TaskStatus, revert = false) {
    // Unsuccessful outcomes are finalized even while the agent is paused/stopped (audit export).
    const purpose = outcome === 'completed' ? undefined : ('cleanup' as const);
    const result = await lock.withWorkspace(
      () =>
        finalizer.finalizeTask.executeWithOptions({ ...FINALIZE_OPTIONS, summary: `Finalize · ${outcome}` }, [
          { taskId, outcome, state: { ...state, status: outcome }, meta: meta(), revert, summary: `Finalize · ${outcome}` },
        ]),
      { purpose },
    );
    const last = [...state.steps].reverse().find((s) => s.kind !== 'plan') ?? state.steps[state.steps.length - 1];
    state.result = {
      summary: last?.summary ?? '',
      outputs: [...new Set(state.steps.flatMap((s) => s.filesTouched))],
      finalCommit: result.finalCommit,
      auditPath: result.auditPath,
    };
    return result;
  }

  function finish(status: TaskStatus): TaskResult {
    setStatus(status);
    return {
      taskId,
      status,
      summary: state.result?.summary,
      finalCommit: state.result?.finalCommit,
      auditPath: state.result?.auditPath,
      error: state.error,
    };
  }

  /** Writes the audit export for unsuccessful outcomes. Never throws. */
  async function cleanup(outcome: TaskStatus, revert = false) {
    try {
      await finalize(outcome, revert);
    } catch (err) {
      log.error('cleanup/finalize failed', { outcome, error: String(err) });
    }
    const kind: NotificationKind | undefined =
      outcome === 'cancelled' || outcome === 'rejected' || outcome === 'expired' || outcome === 'budget_exceeded'
        ? outcome
        : outcome === 'failed'
          ? 'failed'
          : undefined;
    if (kind) await notify(kind, state.error);
  }

  /* --------------------------------------------------------------- main flow (spec §7.5.1) */

  async function run(): Promise<TaskResult> {
    if (input.type === 'upload') {
      setStatus('running');
      const summary = `Upload · ${input.attachments?.length ?? 0} file(s)`;
      const r = await lock.withWorkspace(() =>
        uploads.applyUpload.executeWithOptions({ ...UPLOAD_OPTIONS, summary }, [
          { taskId, files: input.attachments ?? [], requestedBy: input.requestedBy, meta: meta(), summary },
        ]),
      );
      state.steps.push({ stepId: `${taskId}:upload:1`, kind: 'run', summary: `Uploaded ${r.paths.join(', ')}`, commit: r.commit, startedAt: state.createdAt, endedAt: new Date().toISOString(), tokens: 0, artifacts: [], filesTouched: r.paths });
      setStatus('finalizing');
      await finalize('completed');
      await notify('completed');
      return finish('completed');
    }

    // 1. PLAN (+ optional approval with revise loop). The lock is NOT held while waiting.
    let revision: { comment: string; by: string } | undefined;
    let approval: { comment?: string; by: string } | undefined;
    for (;;) {
      setStatus('planning');
      const plan = await lock.withWorkspace(() => step('plan', planPrompt(taskId, input, revision)));
      state.plan = { path: workspacePaths.plan(taskId), summary: plan.summary, commit: plan.commit };
      if (input.approval !== 'plan') break;

      const d = await awaitDecision('plan');
      if (d.decision === 'approve') {
        state.approvedPlan = { path: state.plan.path, decidedBy: toIdentity(d.by), comment: d.comment, at: new Date().toISOString() };
        approval = { comment: d.comment, by: d.by.name || d.by.upn };
        break;
      }
      if (d.decision === 'reject') {
        state.error = d.comment;
        await cleanup('rejected');
        return finish('rejected');
      }
      state.revisions += 1;
      revision = { comment: d.comment ?? '', by: d.by.name || d.by.upn };
    }

    // 2. RUN
    setStatus('running');
    await stepWithDelegations('run', runPrompt(taskId, input, approval));

    // 3. VERIFY ↔ FIX
    for (let round = 1; ; round++) {
      setStatus('verifying');
      const summary = `Verify #${round}`;
      const v: VerifyResult = await lock.withWorkspace(() =>
        verifier.verify.executeWithOptions({ ...VERIFY_OPTIONS, summary }, [
          { taskId, type: input.type, round, stepIds: state.steps.map((s) => s.stepId), summary },
        ]),
      );
      state.verify = { ok: v.ok, reportPath: v.reportPath, anomalies: v.anomalies, round };

      if (v.ok) {
        if (input.approval === 'deviation' && v.anomalies.length > 0) {
          const d = await awaitDecision('deviation');
          if (d.decision === 'approve') break;
          if (d.decision === 'reject') {
            state.error = d.comment;
            await cleanup('rejected', true);
            return finish('rejected');
          }
          if (round > settings.maxFixRounds) {
            state.error = 'Maximum number of fix rounds reached';
            await cleanup('failed');
            return finish('failed');
          }
          setStatus('fixing');
          await stepWithDelegations('fix', fixPrompt(taskId, input, v, d.comment));
          continue;
        }
        break;
      }

      if (round > settings.maxFixRounds) {
        state.error = `Verification failed after ${settings.maxFixRounds} fix round(s)`;
        await cleanup('failed');
        return finish('failed');
      }
      setStatus('fixing');
      await stepWithDelegations('fix', fixPrompt(taskId, input, v));
    }

    // 4. FINALIZE (final commit + permanent audit export)
    setStatus('finalizing');
    await finalize('completed');
    await notify('completed');
    return finish('completed');
  }

  try {
    return await mainScope.run(run);
  } catch (err) {
    // A requested cancellation always ends as cancelled, also if the running activity reports its stop as a plain failure
    // (e.g. the exfiltration guard stopped the step before Temporal's cancel request reached the activity).
    if (isCancellation(err) || state.cancelRequested) {
      await CancellationScope.nonCancellable(() => cleanup('cancelled'));
      if (state.cancelRequested) return finish('cancelled');
      setStatus('cancelled');
      throw err; // cancellation requested through Temporal itself (e.g. Temporal UI)
    }
    if (err instanceof BudgetExceeded) {
      state.error = err.message || `Token budget of ${state.usage.maxTokens} exhausted (${state.usage.tokens} used)`;
      await cleanup('budget_exceeded');
      return finish('budget_exceeded');
    }
    if (err instanceof ApprovalExpired) {
      state.error = `No decision within ${settings.approvalExpireAfter}`;
      await cleanup('expired');
      return finish('expired');
    }
    state.error = err instanceof Error ? err.message : String(err);
    await CancellationScope.nonCancellable(() => cleanup('failed'));
    setStatus('failed');
    if (err instanceof ApplicationFailure || err instanceof ActivityFailure) throw err;
    throw ApplicationFailure.nonRetryable(state.error, 'TaskFailed');
  }
}
