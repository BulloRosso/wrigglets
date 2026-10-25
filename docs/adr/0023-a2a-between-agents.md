# ADR-0023: Agent-to-agent delegation (A2A) — discovery sets, gateway-mediated, delegations are tasks

- **Status:** Accepted
- **Date:** 2026-10-25

## Decision

- **Protocol:** A2A v1.0 (JSON-RPC binding) with the official SDK `@a2a-js/sdk` 1.3.
  - Each agent serves an Agent Card at `/.well-known/agent-card.json` and the JSON-RPC endpoint `/a2a`.
    Its skills are the task types analysis, report and change.
  - Both endpoints accept **only** the MCP gateway (shared `A2A_GATEWAY_TOKEN` plus `x-a2a-caller`), never browser
    sessions, and are reachable only on the internal Docker network.
- **Discovery set:** `AgentSpec.peers` per agent, edited on the agent's *Collaboration* tab.
  - **Default: empty, so the agent is isolated.**
  - The set is directed: Max → Lara does not allow Lara → Max.
- **Tools for the model:** the gateway adds `a2a__list_agents`, `a2a__send_task` and `a2a__get_task`. On every call it:
  - enforces the discovery set;
  - checks the kill switch of the caller **and** the callee (paused or stopped peers are invisible);
  - blocks delegation loops (A→B→A over open delegations);
  - audits the call.
- **Delegations are tasks:** an incoming message starts a normal `TaskWorkflow` named `task-a2a-<a2a task id>`.
  - Its trigger is `{ kind: 'agent', callerAgentId, callerTaskId, a2aTaskId }`.
  - `requestedBy` is the person who requested the calling task ("on behalf of"). The gateway supplies it from the
    caller's current step context.
  - The callee's own approval policy applies (default `plan`), so a person on the callee side can still approve or reject.
- **Asynchronous:** `send_task` returns immediately.
  - The calling `TaskWorkflow` records the delegation from the harness tool output.
  - It then waits in status `awaiting_delegations` **without holding the workspace lock**, polling
    `checkDelegations` every 30 s. The deadline is the approval expiry.
  - When all delegations are terminal, it runs an *integrate* step with their results, for up to 3 rounds.
  - Replay fixture: `delegation.json`.

## Azure

Agents run as App Services without public access. A2A traffic goes through the broker behind APIM (ADR-0021), and
Entra workload identities replace the shared token (app roles per discovery edge).

## Consequences

- Collaboration is opt-in and auditable on both sides (caller task ↔ callee task). It is subject to the same
  approvals and kill switch as any other task.
- Delegation latency is at least one poll interval (30 s), which is acceptable for business tasks that take minutes.
