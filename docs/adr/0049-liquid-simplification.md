# ADR-0049: Simplification — event log as truth, embedded policy, enterprise core, Git host, one approval mechanism

- **Status:** Accepted
- **Date:** 2026-11-17
- **Supersedes in part:** [ADR-0044](0044-policy-as-code-opa.md) (OPA service), [ADR-0045](0045-business-workflows-temporal.md) (business-worker service), [ADR-0046](0046-config-repository-proposals.md) (console review of proposals)
- **Extends:** [ADR-0040](0040-lake-ducklake-event-log.md), [ADR-0047](0047-playbooks-tighten-only.md), [ADR-0048](0048-ontology-evolution-runtime.md)

## Context

After M8 the extension had all the planned features but had grown many parts: an OPA container, a separate business
worker, three audit trails beside the event log, four places where people approved something (four-eyes cards,
playbook steps, config proposals, wiki proposals), sensing that bypassed the event log, and code generated from the IR
that had to be rebuilt for every ontology version. A simplification review listed six items. The goal was fewer moving
parts **without removing a feature or loosening a security default**.

Decisions made with the user before the work started:

| Question | Decision |
|---|---|
| Lake format | keep DuckLake (no Iceberg migration) |
| Config review | a real Git host, **Forgejo**, with pull requests; the company wiki service stays |
| Policy engine | OPA compiled to **WASM**, embedded in the MCP gateway **and** the enterprise core (the gateway's role check stays) |
| Shared Postgres | only the Liquid schemas share `ontology-db` (LiteLLM and Temporal are untouched) |

## Decision

1. **The event log is the one source of truth; audit is a query over it.** While Liquid is installed, the control
   plane forwards the admin audit (`AdminAction`), the gateway's tool calls and policy decisions (`GatewayToolCall`,
   `PolicyDecision`) and the agents' application audit (`AgentAppAction`) into the event log. It polls with persisted
   cursors and deterministic event ids, so a restart or a re-sent entry never appends twice. Reconcile runs become
   `ConfigReconciled`; safety trips, observations and alerts are events too. The original files stay as each component's
   local buffer and keep working without Liquid. *Liquid enterprise → Event log* queries all of it
   (`/internal/events/query`: type, object, actor, time window).
2. **Policy is embedded.** The compiler service builds the Rego of the applied revision into a WASM module
   (`POST /build-wasm`). The control plane serves module plus data document at `/internal/liquid/policy` (ETag =
   content revision; gateway token or the extension's `policy_token`). The gateway and the enterprise core load it into
   `@cw/policy-wasm` and poll every 5 s. The host supplies the two builtins the policies use (`time.now_ns`,
   `time.parse_rfc3339_ns`). **Fail closed is unchanged:** no package loaded, a failed load or no decision means
   denied. The OPA container is gone; `opa test` stays in the checks, with fixtures computed from the IR.
3. **The enterprise core.** The business worker (Temporal worker, event dispatcher) runs inside the ontology server
   process (`src/worker/*`). Its dispatch cursor is the table `dispatch_cursor` in `ontology-db`, written in the same
   database as the events. An install of the new manifest removes the containers of retired services (install step
   `retired`).
4. **The ontology is interpreted at runtime** (ADR-0048). Only the SDK and its types are generated and checked in.
   Tool schemas, input validation, DDL, data-quality checks and OPA data come from the IR in force.
5. **Config changes are pull requests on Forgejo.** Forgejo 15.0.11 LTS (pinned by digest) is a service of the
   extension. Its database is in `ontology-db`; its web UI is on `127.0.0.1:3300` only. Bootstrap creates:
   - the bot `liquid-bot`, the user `reviewer`, the organisation `liquid` with team `reviewers`, and the repository
     `liquid/config`;
   - `CODEOWNERS` generated from `OWNERS.yaml`;
   - branch protection on `main`: one approval, required check `liquid/validate`, only the bot may push;
   - a webhook to the control plane.

   A proposal (from an agent, the editor or a playbook) is a branch plus a PR. Its validation result is posted as the
   commit status `liquid/validate`. Review, approval and merge happen on the Git host. The signed webhook marks the
   proposal approved or rejected and triggers a reconcile. Console edits are still direct commits on `main`, pushed by
   the bot. The console no longer decides proposals that have a PR (409 with the link).
6. **One approval mechanism.** Every decision a person takes inside Liquid is an `ApprovalWorkflow` in the business
   namespace, with kind `action` (four eyes), `playbook-step` (a playbook's human step is a child workflow of the run)
   or `wiki` (wiki proposals are mirrored, and deciding either side settles both). *Liquid enterprise → Approvals*
   lists them in one inbox, with config PRs and agent plan approvals as links. Each new item is mailed once with a deep
   link (`/liquid/approvals?focus=<id>`, ADR-0026 pattern).
7. **One sensing path.** Alerts, safety trips, schedules and signals observations all become events first; playbooks
   subscribe to event types.

## Deviations and why

- **Plan approvals of agent tasks stay with the agent app**: its approver policy (who may approve a plan for which
  task) lives there. The inbox links to them instead of copying the decision.
- **The safety engine still enforces in-process** (kill switch at once, ADR-0022); it also emits `SafetyRuleTripped`.
  Making enforcement wait for a playbook would loosen a security default.
- **The wiki keeps its own review page**; the approval is a mirror, not a replacement (the user chose to keep the
  wiki service).
- **Overlay mode** (compose) keeps the built-in console review until Forgejo is set up, so the dev path without the
  Git host still works.

## Consequences

- Two fewer containers (OPA, business-worker), one more (Forgejo). One database, one audit query, one inbox.
- A Forgejo outage blocks new proposals and merges but not running work: `main` is mirrored locally, the reconciler
  keeps applying it, and console edits are committed locally and pushed when the host is back.
- Concurrency between edits and the reconciler had to be made explicit. A console edit or playbook step that changed
  a store but was not yet committed could be taken for drift and reverted. Edits now register (`beginEdit`/`endEdit`)
  and a reconcile meanwhile defers.
- Forgejo's PR numbers restart after a reinstall with purge, so webhook events are matched to proposals by branch
  first.
