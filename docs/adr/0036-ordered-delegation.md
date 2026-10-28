# ADR-0036: Ordered delegation: the platform keeps the order of dependent work

- **Status:** Accepted
- **Date:** 2026-10-28
- **Extends:** [ADR-0023](0023-a2a-between-agents.md)

## Context

`a2a__send_task` is fire-and-forget. When one task depends on the result of another (customer notices need the new delivery
dates that the planner produces), the order lived only in the agent's plan. In a run of the sofa-company example the plan
listed the planner and the sales colleague as follow-ups; after the procurement result arrived the agent reported and
finished, and the customers were never told.

## Decision

- `a2a__send_task` takes an optional `after`: task ids that earlier `a2a__send_task` calls returned. The agent declares
  the **whole chain in one step**, while the approved plan is fresh.
- The gateway holds such a task back (state `submitted`, summary "Waiting for … to finish first") and sends it to the
  colleague **only when all predecessors have completed**. The instructions it sends carry the predecessors' results.
- A predecessor that fails, is rejected or cancelled **cancels** the dependent task; it is never started on missing input.
  Cancellation travels along a chain.
- The policy is checked again at start time (colleague paused by the kill switch, delegation loop).
- The caller's `TaskWorkflow` needs no change: it already polls `/a2a/status` for its delegations every 30 seconds and
  waits until all are terminal. Each poll advances the queue; the queue id is the task id the workflow follows, and it
  resolves to the real remote task once dispatched. Queue state is persisted (`a2a-queued.json`).
- Only the caller's own delegations may be named in `after` (checked against what the gateway handed out), at most five.
- Waiting edges count for the loop check.

## Consequences

- "Customer notices only after the new dates" is enforced, not requested; a forgotten follow-up is still possible if the
  agent never sends it, but the chain is declared at once and visible in the plan.
- The colleague of a dependent task is asked (and their person approves) only after the predecessor finished.
- Not covered: a plan-versus-execution check (did the agent send everything its plan names?), and a case that owns the
  end-to-end result.
