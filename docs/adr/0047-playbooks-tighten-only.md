# ADR-0047: Playbooks, autonomy tiers and the tighten-only rule

- **Status:** Accepted
- **Date:** 2026-11-16
- **Extends:** [ADR-0022](0022-kill-switch.md) (safety rules), [ADR-0044](0044-policy-as-code-opa.md), [ADR-0045](0045-business-workflows-temporal.md), [ADR-0046](0046-config-repository-proposals.md)

## Context

Plan M7: a general "sense → decide → act" loop. Incidents (a vulnerable upstream, a tripped safety rule) should be
contained automatically, with the blast radius known from the ontology, and loosening must stay a human decision.

## Decision

1. **Playbooks are YAML in the config repository** (`playbooks/*.yaml`), validated by `@cw/playbooks` (zod) at proposal
   validation, at reconcile, and again per step at run time. Each step type is registered with a **direction**:
   tighten (`gateway.upstream.disable`, `killswitch.raise`, `policy.overlay.add`, `temporal.hold`,
   `entra.revoke_scope`), neutral (`notify`, `shadow.replay`, `agent.task`, `config.propose`), loosen (`restore`,
   `policy.overlay.remove`, `temporal.release`, `gateway.upstream.enable`, `killswitch.lower`). **A loosening step
   must have autonomy `human`**; the control plane refuses to execute one without a person's approval.
2. **One sensing path.** Alerts (`POST /internal/alerts`, extension token; or the console's test alert), safety-rule
   trips (the safety engine stays the evaluator and enforcer, unchanged, and additionally emits the trip), schedule
   ticks and event-log events are all recorded as events (`AlertReceived`, `SafetyRuleTripped`, `ScheduleTick`) and
   start the `PlaybookRun` of every playbook whose trigger matches.
3. **`PlaybookRun` is a Temporal workflow** in namespace `business` (same worker as M5), durable across restarts.
   `auto` steps run at once; `propose` steps create something a person decides later (agent task request, config
   proposal) without blocking the run; `human` steps wait for the update `decideStep` (same decide-with-validator
   pattern as the ApprovalWorkflow; the ApprovalWorkflow itself executes ontology actions, so it is not reused as is).
   Cancelling stops the run before its next step and never loosens anything.
4. **Steps are executed by the control plane** (`/internal/liquid/playbooks/execute`, extension token): it owns the
   gateway, overlays, holds and kill switch. Tightening steps return undo data; `restore` reverts them newest first.
   Store changes are committed to the config repository (author = the run), so the reconciler keeps them. Every
   executed step, decision and run end is an event (`PlaybookStepExecuted`, `PlaybookStepDecided`,
   `PlaybookRunFinished`, `IncidentRecorded`).
5. **Blast radius** is a pure function: upstream → its tools → ontology actions → classes (targets and class inputs) →
   running business workflows touching those classes and their objects.
6. **Shadow replay** is the event log replayed with a candidate configuration, in the ontology server: the state at
   the window start is folded from T0 and the recorded changes, actions in the window are re-run under the candidate
   (overlays, disabled actions), other changes are applied as recorded. The report (blocked actions, divergences, KPI
   delta) is deterministic and carries a hash.
7. **Entra** (`entra.revoke_scope`) is a local stand-in until M9: it removes the upstream's tool patterns from the
   agent's allow-list.

## Consequences

- With the example playbook, an alert disables the upstream, adds four eyes on the actions it reached, holds the
  touched workflows and replays the week — automatically; only `restore` waits (verified end to end).
- The safety rules are not rewritten as playbooks: their behaviour stays in the safety engine (no change), and
  `safetyRuleToPlaybook` shows the equivalence (same inputs, same levels; tested). Playbooks can subscribe to the trips.
- Starting a real agent task from `agent.task` needs a person (no automatic model spend); the request is an event.
- Comparisons in the shadow replay ignore wall-clock timestamps, the row-order field and attributes absent in older
  events (an ontology version without them), so an unchanged configuration replays with zero divergence.
