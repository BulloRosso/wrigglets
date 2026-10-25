import {
  allHandlersFinished,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  log,
  proxyLocalActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { Duration } from '@temporalio/common';
import type { AgentState } from '@cw/shared';
import type { AgentLocalActivities } from './activity-types.js';
import {
  acquireSignal,
  agentStatusQuery,
  forceReleaseSignal,
  grantedSignal,
  releaseSignal,
  setKillSwitchSignal,
  suspendSignal,
} from './messages.js';

const { isWorkflowRunning } = proxyLocalActivities<AgentLocalActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3 },
});

const STALE_CHECK_INTERVAL = '5 minutes';
const MAX_HISTORY_EVENTS = 5_000;

export interface AgentWorkflowInput {
  agentId: string;
  state?: AgentState;
  /** Overrides for tests. */
  tuning?: { staleCheckInterval?: string; maxHistoryEvents?: number };
}

/**
 * Singleton per agent (`agent-<agentId>`): FIFO mutual exclusion over the workspace (spec §7.4).
 * Holders are task and maintenance workflows; they signal `acquire`/`release`, we signal `granted`.
 *
 * Kill switch (ADR-0022): while the agent is `paused` or `stopped` no lock is granted (except for
 * cleanup/audit finalization) and the current holder is told to suspend its step.
 */
export async function agentWorkflow(input: AgentWorkflowInput): Promise<void> {
  const state: AgentState = input.state ?? {
    agentId: input.agentId,
    waiting: [],
    stats: { grantsTotal: 0, forcedReleases: 0 },
  };
  state.stats.forcedReleases ??= 0;
  state.stats.suspensions ??= 0;
  /** Holders that asked again although they already hold the lock: re-send `granted`. */
  const regrant = new Set<string>();
  let suspendPending = false;

  const blocked = () => state.killSwitch?.level === 'paused' || state.killSwitch?.level === 'stopped';
  /** Index of the next request that may be granted now, or -1. */
  const nextGrantable = () => (blocked() ? state.waiting.findIndex((w) => w.purpose === 'cleanup') : state.waiting.length ? 0 : -1);

  setHandler(acquireSignal, ({ taskId, purpose }) => {
    if (state.holder?.taskId === taskId) {
      regrant.add(taskId);
      return;
    }
    if (state.waiting.some((w) => w.taskId === taskId)) return;
    const entry = { taskId, requestedAt: new Date().toISOString(), purpose };
    // A suspended task resumes before tasks that have not started their step yet.
    if (purpose === 'resume') state.waiting.unshift(entry);
    else state.waiting.push(entry);
  });

  setHandler(releaseSignal, ({ taskId }) => {
    if (state.holder?.taskId === taskId) state.holder = undefined;
    state.waiting = state.waiting.filter((w) => w.taskId !== taskId);
    regrant.delete(taskId);
  });

  setHandler(forceReleaseSignal, ({ taskId, by }) => {
    if (state.holder?.taskId !== taskId) return;
    state.holder = undefined;
    state.stats.forcedReleases += 1;
    state.lastForceRelease = { taskId, by, at: new Date().toISOString() };
  });

  setHandler(setKillSwitchSignal, (ks) => {
    state.killSwitch = ks;
    if (blocked() && state.holder && state.holder.purpose !== 'cleanup') suspendPending = true;
  });

  setHandler(agentStatusQuery, () => ({ holder: state.holder, waiting: state.waiting, stats: state.stats, killSwitch: state.killSwitch }));

  const staleCheckInterval = (input.tuning?.staleCheckInterval ?? STALE_CHECK_INTERVAL) as Duration;
  const maxHistoryEvents = input.tuning?.maxHistoryEvents ?? MAX_HISTORY_EVENTS;
  const shouldContinueAsNew = () =>
    workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > maxHistoryEvents;

  async function grant(taskId: string): Promise<boolean> {
    try {
      await getExternalWorkflowHandle(taskId).signal(grantedSignal, { taskId });
      return true;
    } catch (err) {
      // The waiting workflow no longer exists (completed, terminated): skip it.
      log.warn('could not deliver grant', { taskId, error: String(err) });
      return false;
    }
  }

  for (;;) {
    const woke = await condition(
      () => (!state.holder && nextGrantable() >= 0) || regrant.size > 0 || suspendPending || shouldContinueAsNew(),
      staleCheckInterval,
    );
    if (shouldContinueAsNew()) break;

    if (suspendPending) {
      suspendPending = false;
      const holder = state.holder;
      if (holder && holder.purpose !== 'cleanup' && blocked()) {
        try {
          await getExternalWorkflowHandle(holder.taskId).signal(suspendSignal, { taskId: holder.taskId, reason: state.killSwitch?.reason });
          state.stats.suspensions = (state.stats.suspensions ?? 0) + 1;
        } catch (err) {
          log.warn('could not deliver suspend', { taskId: holder.taskId, error: String(err) });
        }
      }
      continue;
    }

    if (regrant.size > 0) {
      for (const taskId of [...regrant]) {
        regrant.delete(taskId);
        if (state.holder?.taskId === taskId) await grant(taskId);
      }
      continue;
    }

    const idx = state.holder ? -1 : nextGrantable();
    if (idx >= 0) {
      const next = state.waiting.splice(idx, 1)[0]!;
      state.holder = { taskId: next.taskId, since: new Date().toISOString(), purpose: next.purpose };
      if (await grant(next.taskId)) state.stats.grantsTotal += 1;
      else if (state.holder?.taskId === next.taskId) state.holder = undefined;
    } else if (!woke && state.holder) {
      // Stale-lock protection: the holder closed without releasing.
      const holderId = state.holder.taskId;
      const running = await isWorkflowRunning({ workflowId: holderId });
      if (!running && state.holder?.taskId === holderId) {
        log.warn('clearing stale lock', { holderId });
        state.holder = undefined;
      }
    }
  }

  await condition(allHandlersFinished);
  await continueAsNew<typeof agentWorkflow>({ agentId: input.agentId, state, tuning: input.tuning });
}
