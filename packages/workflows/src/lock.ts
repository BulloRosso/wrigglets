import { CancellationScope, condition, getExternalWorkflowHandle, isCancellation, setHandler } from '@temporalio/workflow';
import { agentWorkflowId } from '@cw/shared';
import { acquireSignal, grantedSignal, releaseSignal, suspendSignal } from './messages.js';

export type LockState = 'none' | 'waiting' | 'held';

/**
 * Client side of the workspace lock (spec §7.5 `withWorkspace`). Must be created at the start of the
 * workflow because it registers the `granted` and `suspend` signal handlers.
 *
 * The lock is held only for the duration of `fn` — never while waiting for a human.
 *
 * Kill switch (ADR-0022): when the lock manager sends `suspend` (agent paused), the running `fn` is
 * cancelled (the step activity aborts the harness turn), the lock is released and re-requested with
 * purpose `resume`; once the agent is resumed `fn` runs again from the start. Steps are idempotent
 * (uncommitted changes are reset), so re-running is safe.
 */
export function createWorkspaceLock(
  agentId: string,
  holderId: string,
  onChange: (s: LockState) => void,
  onSuspend?: (suspended: boolean, reason?: string) => void,
) {
  const lockWorkflowId = agentWorkflowId(agentId);
  let state: LockState = 'none';
  let granted = false;
  let current: CancellationScope | undefined;
  let suspended: { reason?: string } | undefined;

  const set = (s: LockState) => {
    state = s;
    onChange(s);
  };

  setHandler(grantedSignal, ({ taskId }) => {
    // Ignore stale or misrouted grants: only a waiting holder can be granted.
    if (taskId === holderId && state === 'waiting') granted = true;
  });

  setHandler(suspendSignal, ({ taskId, reason }) => {
    if (taskId !== holderId || state !== 'held' || !current || suspended) return;
    suspended = { reason };
    current.cancel();
  });

  async function withWorkspace<T>(fn: () => Promise<T>, opts: { purpose?: 'cleanup' } = {}): Promise<T> {
    let purpose: 'cleanup' | 'resume' | undefined = opts.purpose;
    for (;;) {
      granted = false;
      set('waiting');
      let resume = false;
      try {
        await getExternalWorkflowHandle(lockWorkflowId).signal(acquireSignal, { taskId: holderId, purpose });
        await condition(() => granted);
        set('held');
        if (purpose === 'resume') onSuspend?.(false);
        const scope = new CancellationScope();
        current = scope;
        return await scope.run(fn);
      } catch (err) {
        // Suspension (not a cancellation of the task itself): retry after the agent is resumed.
        if (suspended && isCancellation(err) && !CancellationScope.current().consideredCancelled) resume = true;
        else throw err;
      } finally {
        current = undefined;
        granted = false;
        set('none');
        // Always give the lock back (also when cancelled while waiting: this removes us from the queue).
        await CancellationScope.nonCancellable(() =>
          getExternalWorkflowHandle(lockWorkflowId).signal(releaseSignal, { taskId: holderId }),
        );
      }
      if (resume) {
        onSuspend?.(true, suspended?.reason);
        suspended = undefined;
        purpose = 'resume';
      }
    }
  }

  return {
    withWorkspace,
    get state() {
      return state;
    },
  };
}
