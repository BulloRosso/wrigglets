# ADR-0052: Acceptance D2/D3 — core checks switched on by the ontology, workflow v2 by ontology version

- **Status:** Accepted
- **Date:** 2026-11-17
- **Extends:** [ADR-0045](0045-business-workflows-temporal.md), [ADR-0047](0047-playbooks-tighten-only.md), [ADR-0048](0048-ontology-evolution-runtime.md), [ADR-0051](0051-control-loop-health-robustness.md)

## Context

M10 runs the two adaptation scenarios of the plan end to end:
- **D2:** a new security risk, contained automatically and recovered by a person.
- **D3:** a new business requirement. Purchase orders for high-risk commodities need a valid supplier due-diligence
  statement before release.

D3 needs things M8's runtime ontology cannot provide from data alone:
- a business rule on an existing, domain-coded action (`release_purchase_order`);
- a new wait step in a running workflow type, while orders already in flight finish on the old version.

Three operator decisions were taken before M10 (2026-11-17):
- *Delete data* also removes the control plane's Liquid data, without archive.
- Forgejo is added to the compose overlay, and the console review is dropped.
- A simulation reset withdraws pending four-eyes approvals.

The live Entra check is postponed.

## Decision

1. **Core checks.** Named preconditions such as `due_diligence_for_high_risk_material` are code in the enterprise core
   (`checks.ts`). The ontology switches them on per action (`preconditions: [...]` in `actions.yaml`). The action
   pipeline evaluates the core checks of the action in force before running it; a refusal writes nothing, like a
   domain precondition. A check reads the ontology's objects, including the attributes and classes a newer version
   added. Its logic ships with the core; *whether* it applies is a reviewed change.
2. **Workflow v2 chosen by the ontology.** `PurchaseOrderRelease` has a due-diligence gate behind `patched()`. The
   dispatcher sets `dueDiligence` when it starts a workflow and the ontology in force puts the check on the release.
   The workflow then:
   - waits in `awaiting_due_diligence`;
   - re-checks every `DUE_DILIGENCE_POLL_MS`;
   - reminds once after `DUE_DILIGENCE_REMINDER_MS`;
   - releases when the check passes.

   Workflows started earlier carry no flag and finish on v1; the patch marker keeps both kinds of history replayable.
3. **Evidence for a rule before it applies.** `POST /api/liquid/shadow/precondition` evaluates a core check over the
   releases of a window, with assumed attribute values such as "timber is high-risk". It reports the share of
   releases that would have waited, and goes into the proposal as evidence.
4. **Notifications reach people.** A playbook's `notify` step takes `to:` recipients and writes to the mail outbox,
   e.g. the security owner in D2.
5. **No automatic loosening, also not "after a clean replay".** D2's last step in the plan, a playbook that remediates
   automatically, is proposed by the agent and refused by validation. The tighten-only rule is a security default and
   stays.
6. **Operator decisions:**
   - *Delete data* has a step *Delete its data in the control plane*: app OIDC clients, config repository, proposals,
     app registry, drafts.
   - Overlay mode runs the Git host bootstrap itself (`bootstrap` of the overlay, retried until it succeeds; `exec` in
     the overlay's containers).
   - The console route for deciding proposals is gone. Pending proposals without a pull request get one as soon as the
     host is reachable.
   - `SimulationReset` withdraws pending four-eyes approvals, matched by their request-event id; playbook and wiki
     approvals stay.

## Consequences

- Business rules beyond create, read, update and delete still need code. The ontology decides where and when they apply,
  so the change itself is reviewed, versioned and replayable. This is the honest boundary of "the system extends
  itself through the ontology".
- A rule switched on in the ontology applies to direct calls at once. Workflows already in flight that would hit it are
  not protected by the version split; in D3 the in-flight order had been released before the change.
- The compose overlay now needs Forgejo like the console install; the development setup is heavier but has one review
  path. The overlay path is covered by unit tests; it was not run end to end, because the stack ran in console mode.
