# ADR-0051: Control loop health and robustness rules

- **Status:** Accepted
- **Date:** 2026-11-17
- **Extends:** [ADR-0046](0046-config-repository-proposals.md), [ADR-0049](0049-liquid-simplification.md), [ADR-0050](0050-entra-option-app-registry.md)

## Context

After M9 an optimisation run asked two questions: what can be simplified without losing a feature, and how can the
setup become more robust and controllable?

The complete runtime test, run many times on fresh installs, was the evidence. Every failure it found was one of two
kinds:
- **Concurrency between independent loops:** a reconcile reverting an edit that was not yet committed, a suite
  starting before the policy engines had picked up a removed overlay, webhooks lost while the control plane
  restarted.
- **State outliving its context:** holds and overlays left by an aborted run, release workflows of a world that a
  simulation reset had replaced, proposals whose pull request belonged to a Git host that was recreated.

Each failure was invisible until a check tripped over it.

## Decision

1. **One health view of the control loop.** `GET /api/liquid/health`, the *Control loop health* card on the Overview
   page, and `node scripts/liquid/doctor.mjs` (exit code 0/1/2) all report one item per part. Each item has a status
   (ok, warn, fail), a detail and a hint:

   | Item | What it checks |
   |---|---|
   | Services | every service running |
   | Policy distribution | package built and compiling; gateway and core on the current revision |
   | Enterprise core | dispatcher lag and progress, lake lag, policy loaded |
   | Config reconciler | last run, last result, main applied |
   | Git host | reachable, set up, last failed call |
   | Audit into the event log | last forwarding run |
   | Decisions | pending approvals and their age, playbook runs waiting |
   | Tightening in force | kill switch, overlays, held workflows (with their refs) |
   | Apps | expiring within 14 days, failed re-checks |

   Each probe has its own timeout, so one broken part never hides the others. The core contributes
   `/internal/health/loop`. The static "layers" list on the Overview page is replaced by this live view.
2. **Robustness rules**, each found by the runtime test and now enforced in code:
   - *An edit is committed before it can be taken for drift.* Console edits and playbook steps register while their
     change is in flight, and the reconciler defers meanwhile.
   - *A webhook is a hint, the host is the truth.* Every reconcile settles pending proposals from the state of their
     pull request on the host: merged, closed, gone, or the number reused by another branch.
   - *Retry only what is safe to repeat.* Git host reads retry on network errors and 502/503/504. Writes retry only
     when the connection was refused, so a retried call can never open a second pull request.
   - *A reset ends what belongs to the old world.* `SimulationReset` cancels the running `PurchaseOrderRelease`
     workflows, whose order ids are reused by the new world.
   - *Browser URLs come from the public host.* The Git host's `ROOT_URL` and pull request links are derived from
     `PUBLIC_URL` (`{{svc:NAME.public}}` in manifests), not hard-coded to localhost.
   - *Every loop reports its last run,* also when there was nothing to do, so a stalled loop is visible.
   - *Nothing writes the stores while the extension is being changed.* Every reconcile checks the gate (installed, no
     extension operation running), whoever triggers it (timer, webhook, deferred edit), and checks it again right
     before applying. Follow-ups of an operation run only after it is unregistered. Before this, a webhook-triggered
     reconcile during an uninstall re-added the extension's gateway upstream, and the reinstall refused it as not
     owned.
3. **Test suites are independent.** Each suite cleans up the leftovers of an aborted earlier run before it starts,
   releases what it holds in `finally`, and waits until the policy engines have converged before it ends.
   `node scripts/liquid/e2e-all.mjs` runs all of them in order.

## Not decided here (needs the operator)

- **Purge scope.** *Uninstall → delete data* removes the extension's volumes and secrets but keeps `DATA_DIR/liquid`:
  the config repository, proposals and the app registry. A reinstall therefore inherits the desired state, and the
  health view and the settling of proposals keep that consistent. Whether purge should also archive and remove it is
  a data-deletion decision.
- **One review path.** Overlay (compose) mode still reviews proposals in the console because it has no Git host.
  Adding Forgejo to the overlay would remove that second path, at the cost of a heavier development setup.
- **Approvals of a replaced world.** After a simulation reset, pending four-eyes approvals stay open; they expire after
  7 days. Withdrawing them automatically would change approval semantics.

## Consequences

- An operator sees in one place why something does not move. The runtime test runs on a fresh install without manual
  cleanup between suites.
- Probes cost a few queries every 10 s while the Overview page is open. Nothing runs when nobody looks.
