# ADR-0018: Cancellation semantics and lock safety

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §5.3, §7.5.1 (`catch (isCancellation)`), §16.2 ("release is still signalled")

## Decision

- The `cancel` **update** records `cancelRequested {by, reason}` and cancels the workflow's main cancellation scope.
  The workflow then runs `cleanup('cancelled')` (audit export, notification) in a non-cancellable scope and **returns**
  `{status: 'cancelled'}` (workflow completes). A cancellation requested *through Temporal itself* (Web UI/CLI) runs
  the same cleanup and then re-throws (workflow ends as *Canceled*).
- `runAgentStep` uses `cancellationType: WAIT_CANCELLATION_COMPLETED`: the workflow waits until the activity has
  aborted the harness session before it releases the workspace lock — otherwise a still-running harness turn could
  write into the workspace while another task holds the lock.
- Cancellation reaches activities only through heartbeats; the worker sets `maxHeartbeatThrottleInterval: 5 s`
  (default would be up to 60 s).
- `withWorkspace` releases the lock in a `finally` with a non-cancellable signal; `release` also removes the task from
  the waiting queue (cancel while waiting). `acquire` from the current holder re-sends `granted` (idempotency).
- Grants are only accepted while the lock helper is in state `waiting` (stale grants are ignored).

## Verified by

`packages/workflows/test/workflows.test.ts`: "cancellation during a step releases the lock", "clears a stale lock
when the holder was terminated", "continue-as-new preserves the holder and the queue".
