# ADR-0022: Kill switch — graded levels, enforcement points, automatic triggers

- **Status:** Accepted
- **Date:** 2026-10-25

## Decision

**Levels:** `normal < tools_off < paused < stopped`.

- Levels are set **globally** and **per agent**; the effective level is the stricter of the two.
- Any level other than `normal` requires a reason.
- State lives in the control plane (`/data/admin/killswitch.json`).
- Every change is written to the admin audit log and signalled to the agent's `AgentWorkflow`, so it is also in the
  Temporal history.

| Level | Enforcement |
|---|---|
| `tools_off` | The MCP gateway rejects every tool call, including A2A. The agent keeps working on files. |
| `paused` | `AgentWorkflow` grants no workspace lock, except `cleanup` grants for finalising cancelled tasks. The current holder receives a `suspend` signal: it cancels its running step, releases the lock and re-queues **at the front** with purpose `resume`. The task shows `suspended` and re-runs the same step after the pause. |
| `stopped` | As `paused`, plus all running tasks of the agent are cancelled (reason recorded) and then the container is stopped. Lifting `stopped` starts the container again. |

**Automatic triggers:** the safety rule engine in the control plane runs every 30 s. Rules are configurable in the
console; the defaults are:

| Condition | Level |
|---|---|
| Harness permission requests ≥ 1 per hour | `paused` |
| More than 2 M tokens per hour | `paused` |
| More than 20 denied/failed tool calls in 10 min | `tools_off` |
| More than 120 tool calls per minute | `tools_off` |
| 5 or more failed tasks in a row | `paused` |

- Rules only ever **raise** a level and record `auto: { rule }`.
- Lifting a level is always manual. After a manual lift, the agent's rules are snoozed for 60 min.

**Fail-safe:**

- The gateway denies all tool calls when its copy of the state is older than 30 s.
- The control plane re-applies the level to agents every 60 s (`reconcile`), for example after an agent restart.

## Why Temporal for pause

Pausing through the existing FIFO lock needs no new mechanism:

- Tasks keep their place in the queue.
- Approvals still work while paused.
- An aborted step is repeated with the same step id; uncommitted work is reset as on any retry.
- The whole sequence is visible in the workflow history (replay fixture: `suspended-resumed.json`).

## Consequences

- `tools_off` takes effect seconds after the button is pressed. `paused` takes effect when the running activity
  observes the cancellation (heartbeat throttle ≤ 5 s).
- The agent UI shows a banner with the level, the reason and who set it; the portrait switches to the fearful mood.
