import { ApplicationFailure } from '@temporalio/common';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import { SIGNALS_IDENTITY, UNLIMITED_TOKENS, agentWorkflowId, type ExpectationState, type Principal } from '@cw/shared';
import { agentStatusQuery } from '@cw/workflows/messages';
import { SIGNALS_ACTIVITY_ERRORS, fulfillExpectationUpdate, type RaiseSignalResult, type SignalsActivities } from '@cw/signals';
import type { ApiDeps } from '../api/context.js';
import { startTaskWorkflow } from '../api/routes/tasks.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import type { NotificationStore } from '../notifications.js';
import { SignalsAiError, type SignalsService } from './service.js';

export interface SignalsActivityDeps {
  config: Config;
  temporal: () => Client;
  notifications: NotificationStore;
  signals: SignalsService;
}

/** Instructions of the follow-up task: self-contained, the observation is quoted as data. */
export function followUpInstructions(e: ExpectationState): string {
  return [
    `An expectation tracked by Signals is overdue (it was due ${e.dueAt}).`,
    '',
    `**Expected:** ${e.title}`,
    e.description ? `**Why:** ${e.description}` : '',
    e.matchHint ? `**How to recognise it:** ${e.matchHint}` : '',
    `**Origin:** observation from ${e.source.kind}${e.source.subject ? ` "${e.source.subject}"` : ''}${e.source.events.length ? `; events: ${e.source.events.join('; ')}` : ''}`,
    '',
    '## What to do',
    e.taskInstructions?.trim() ||
      'Check with the tools you have whether it has happened after all. If not, prepare a short, polite follow-up (for example an inquiry draft) as a file under reports/ and say who it should go to.',
    '',
    'Do not send anything outside the platform yourself unless your approved plan says so. If the expected thing has happened after all, say so clearly in your result; a person can then mark the expectation as fulfilled.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Workflow-safe task id of the follow-up (one per expectation and due date, so a retried activity starts it once). */
export const followUpTaskId = (e: ExpectationState) => `task-sig-${e.id.replace(/^sig-exp-/, '')}-${Date.parse(e.dueAt).toString(36)}`.slice(0, 125);

async function mailSignal(config: Config, e: ExpectationState, taskId: string | undefined): Promise<number | undefined> {
  const { CONTROL_PLANE_URL: base, CONTROL_PLANE_TOKEN: token, AGENT_ID, publicBaseUrl } = config;
  if (!base || !token) return undefined;
  try {
    const res = await fetch(`${base}/internal/agents/${encodeURIComponent(AGENT_ID)}/notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'signal_raised',
        taskId: taskId ?? e.id,
        title: e.title,
        text: [`Due ${e.dueAt.slice(0, 16).replace('T', ' ')} UTC.`, e.description].filter(Boolean).join(' ').slice(0, 2000),
        link: taskId ? `${publicBaseUrl}/tasks/${encodeURIComponent(taskId)}` : `${publicBaseUrl}/signals?expectation=${encodeURIComponent(e.id)}`,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`control plane returned ${res.status}`);
    return ((await res.json()) as { recipients: number }).recipients;
  } catch (err) {
    logger.warn({ expectation: e.id, err: String(err) }, 'signal mail not sent');
    return undefined;
  }
}

export function createSignalsActivities(deps: SignalsActivityDeps): SignalsActivities {
  const { config, signals } = deps;
  return {
    listOpenExpectations: () => signals.listOpen(),

    async interpretObservation(input) {
      try {
        return await signals.interpret(input.observation, input.open);
      } catch (err) {
        if (err instanceof SignalsAiError) throw ApplicationFailure.nonRetryable(err.message, SIGNALS_ACTIVITY_ERRORS.aiNotConfigured);
        throw err;
      }
    },

    async resolveExpectation(input) {
      try {
        await deps.temporal().workflow.getHandle(input.expectationId).executeUpdate(fulfillExpectationUpdate, { args: [{ by: input.by, reason: input.reason, observationId: input.observationId }] });
        return true;
      } catch (err) {
        if (err instanceof WorkflowUpdateFailedError || err instanceof WorkflowNotFoundError) return false;
        throw err;
      }
    },

    recordObservation: (r) => signals.store.appendObservation(r),

    async raiseSignal({ expectation: e }): Promise<RaiseSignalResult> {
      // Kill switch (ADR-0022): a paused or stopped agent raises nothing; the workflow retries until it runs again.
      const status = await deps.temporal().workflow.getHandle(agentWorkflowId(config.AGENT_ID)).query(agentStatusQuery).catch(() => undefined);
      const level = status?.killSwitch?.level;
      if (level === 'paused' || level === 'stopped') throw ApplicationFailure.retryable(`agent is ${level}`, SIGNALS_ACTIVITY_ERRORS.agentHalted);

      const cfg = await signals.getConfig();
      let taskId: string | undefined;
      // A switched-off module still tells people about open loops, but starts no work.
      if (e.action === 'propose_task' && cfg.enabled) {
        const owner = cfg.owner ? { upn: cfg.owner.upn, name: cfg.owner.name || cfg.owner.upn, oid: cfg.owner.oid || cfg.owner.upn } : SIGNALS_IDENTITY;
        const requester: Principal = { ...owner, roles: [] };
        taskId = followUpTaskId(e);
        try {
          await startTaskWorkflow(
            { config, temporal: deps.temporal() } as unknown as ApiDeps,
            requester,
            {
              title: (e.taskTitle ?? `Follow up: ${e.title}`).slice(0, 120),
              instructions: followUpInstructions(e),
              type: 'analysis',
              // A person always approves the plan of work that Signals starts (ADR-0037): never 'none'.
              approval: 'plan',
              budget: { maxTokens: UNLIMITED_TOKENS },
            },
            { taskId, trigger: { kind: 'signal', expectationId: e.id, observationId: e.source.observationId } },
          );
        } catch (err) {
          if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
        }
        if (cfg.owner) await deps.notifications.append({ to: cfg.owner.upn, kind: 'signal_raised', taskId, title: e.title, text: 'Follow-up task proposed; its plan needs approval.' });
        return { taskId };
      }
      if (cfg.owner) await deps.notifications.append({ to: cfg.owner.upn, kind: 'signal_raised', taskId: e.id, title: e.title, text: `Overdue since ${e.dueAt}` });
      const notified = await mailSignal(config, e, taskId);
      return { notified };
    },
  };
}
