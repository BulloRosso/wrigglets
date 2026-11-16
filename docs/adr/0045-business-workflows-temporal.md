# ADR-0045: Holdable business workflows in a separate Temporal namespace

- **Status:** Accepted
- **Date:** 2026-11-16
- **Extends:** [ADR-0043](0043-ontology-server-action-pipeline.md), [ADR-0044](0044-policy-as-code-opa.md)

## Context

Plan M5: business processes that run for days (a purchase order from creation to delivery, an approval waiting for a
person) must survive restarts, be visible, and be stoppable by business object ("hold everything that touches supplier
Nordholz") without touching code. M4 left four-eyes requests recorded but never executed. The platform already runs
Temporal for the agents' task workflows (namespace `default`), and the plan forbids a second workflow engine.

## Decision

1. **Separate namespace `business`** on the platform's Temporal (task queue `business`), with two custom search
   attributes: `OntologyObjects` (KeywordList, e.g. `Supplier:S-NORDHOLZ`, `PurchaseOrder:PO-4430`) and `BusinessState`
   (Keyword). Agent task workflows and business workflows do not see each other's histories. The namespace is created
   by an idempotent bootstrap step of the extension (`business-namespace`, run by the control plane, which owns the
   Temporal connection); in overlay mode the control plane ensures it at startup.
2. **`@cw/business-workflows`** holds deterministic workflow code only: `holdable()` (signals `hold {reason, ref}` /
   `release {ref}`, query `holdState`; several holds can stack, the workflow continues only when all are released;
   upserts `BusinessState=held`), `PurchaseOrderRelease` (release window → wait while held → `release_purchase_order`
   → timer until the ETA in simulated days → check the order: received / late (notification) / cancelled; signal
   `cancel`), `ApprovalWorkflow` (update `decide` with a validator: one decision only, not after expiry, requester can't
   approve; reminder, expiry; on approval it runs the action with `approvedBy`) and `lakeFlush`. Replay tests against
   recorded histories guard determinism.
3. **The ontology says which action starts or signals a workflow** (`starts_workflow`, `signals_workflow` in
   `actions.yaml`, carried into the IR). Workflows never write the database: every write is an ontology action through
   the ontology server (REST, internal token), so it is validated, policy-checked, audited and an event. Business
   refusals (422/403) are activity results, transport errors and 5xx are retried.
4. **Dispatcher = outbox pattern** in the new `business-worker` service: it reads committed events in `seq` order
   (`GET /internal/events?after=`), starts/signals workflows and persists its cursor (`/data/dispatch-cursor.json`) after
   each event. Workflow ids derive from the event id (`PurchaseOrderRelease-<eventId>`), so a crash between start and
   cursor write cannot start a workflow twice. On first start the cursor begins at the current end of the log (history
   is not replayed into workflows).
5. **Lake flush moves to a Temporal schedule** (`lake-flush`, every minute, overlap skip) owned by the worker; the
   ontology server's own timer is switched off (`FLUSH_INTERVAL_SEC=0`) when the worker is installed.
6. **Hold, release and decisions are made by people in the console** (Liquid enterprise → Business processes,
   Platform.Admin, audited): hold by object queries `OntologyObjects = '<Class:id>' AND ExecutionStatus = 'Running'`
   and signals each match; release by the hold's ref; approve/reject sends the `decide` update with the signed-in
   person as `by`. OPA accepts the approval as the second pair of eyes only if `approved_by` is a non-empty string
   different from the agent and the requesting user.

## Consequences

- Holding is tightening and needs no approval; it never skips or runs a step. Playbooks (M7) can hold by object.
- The worker is stateless apart from the cursor; restarts lose nothing (verified: holds survive, no duplicate starts).
- Simulated time (`SIM_TODAY`, `MS_PER_SIM_DAY`, `RELEASE_AFTER_MS`) keeps demos fast; production values are env only.
- Found on the way: the ontology server sends absent caller fields as `null`, and `null` is truthy in Rego. The object
  policy now tests `is_string(...)`; without that, an agent call with a requesting user and no approval would have
  counted as approved by another person. Regression tests added.
- Mail delivery of notifications is not part of M5: notifications are recorded as `BusinessNotification` events.
