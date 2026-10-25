# ADR-0005: Multiple agents — per-agent task queue, ids and schedules

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §1.2 ("design SHOULD NOT preclude a second agent"), §7.1–§7.3, §7.7, §7.8

## Context

The spec uses one task queue `agent` and ids like `sched-<slug>`. With several agents in one Temporal namespace,
a TaskWorkflow of agent A could be executed by the worker of agent B — which owns a *different* workspace.

## Decision

| Concept | Spec (single agent) | Implementation |
|---|---|---|
| Task queue | `agent` | `agent-<agentId>` (env `TEMPORAL_TASK_QUEUE` can override) |
| Lock manager | `agent-${AGENT_ID}` | unchanged |
| Task | `task-<ULID>` | unchanged (globally unique) |
| User schedule | `sched-<slug>` | `sched-<agentId>-<slug>` |
| System schedule | `sched-sys-git-maintenance` … | `sched-sys-<agentId>-git-maintenance` … |
| Maintenance run | `maint-<kind>-<date>` | `maint-<agentId>-<kind>-<timestamp>` (Temporal appends the timestamp) |
| Namespace | `agent-dev` / `agent-prod` | one namespace for all agents; `AgentId` search attribute on everything |

All visibility queries of an agent always add `AgentId = '<id>'`; schedule listings filter by id prefix.

## Consequences

- Agents are isolated at the worker level while sharing one Temporal cluster and one Web UI.
- Payload encryption uses one key ring for all agents (ADR-0008). Per-agent namespaces/keys remain possible later.
- Deleting an agent with "purge" removes its schedules and terminates its running workflows.
