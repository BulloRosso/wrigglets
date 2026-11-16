# ADR-0043: Ontology server, action pipeline, event-sourced projection

- **Status:** Accepted
- **Date:** 2026-11-16
- **Extends:** [ADR-0040](0040-lake-ducklake-event-log.md), [ADR-0041](0041-ontology-linkml-ir-generators.md)

## Context

Plan M3: the sofa agents must work on the ontology server instead of the mock, unchanged, with comparable results
(demonstration D1). Every change to business data must be a typed action: validated, policy-checked, audited and
emitted as an event (invariant 2). The projection must be a cache that can be rebuilt from the event log (invariant 3).

## Decision

1. **Domain logic** (`packages/sofa-domain`): the mock's logic ported 1:1 into a `SofaCompany` class (state = world +
   id sequences instead of module globals): capacity, simulation, KPI, scenarios and all 31 tools. The mock stays the
   reference: parity tests run the same 57 calls (reads, writes, precondition failures, what-ifs, edge cases) in the
   baseline and all five scenarios against both and compare every answer **byte for byte**, plus world, sequences, write
   count and KPI.
2. **World ⇄ ontology objects** (`objects.ts`): one row per object with the ontology's attribute names, links as ids and
   `ord` (insertion order). The mapping is lossless (values, key order, list order), so a reloaded company answers
   exactly like the original. The ontology gained the attributes the mock uses (`SalesOrder.source`, ticket
   `technician_booked`/`opened_at`, incident `claim`/`filed_at`, notice `recipient`/`sent_at`); the DDL generator adds
   `ord` and applies foreign keys idempotently.
3. **Action pipeline** (`apps/ontology-server`, one path for MCP and REST): validate input with the generated zod schema
   → policy hook (allow until M4, fail closed when configured) → run the handler on a **copy** of the state → a failed
   precondition is answered without any write → a success is **one transaction**: append the event (input, answer,
   write-log entry, the **changed objects** computed as a diff, company values) and upsert the projection rows → swap the
   in-memory state. Read-only actions never write. Writes are serialised (one instance; HA is out of scope).
4. **Events carry state:** `payload.changes = [{ class, id, after }]`. The projection is rebuilt as T0 + all changes in
   seq order, into a scratch schema, compared by row hash, and swapped atomically (`POST /internal/projection/rebuild`,
   `?dryRun=true` to verify only). Scenario disruptions (`SupplierCannotDeliver`, `MachineBrokeDown`, …) and the parity
   runner's reset (`SimulationReset`) are events like any other change. The raw event endpoint takes only test events
   (no ontology event types, no `changes`).
5. **Projection:** schema `projection` from the generated DDL plus `projection.company_meta` (id sequences, cost, write
   count, scenarios). The server applies the DDL on every start, seeds T0 once, then loads its state from the projection.
6. **MCP:** stateless JSON-RPC like the mock (the gateway already speaks it), `/onto/mcp` (all actions) and `/erp/mcp`,
   `/crm/mcp` (parity groups), bearer token per extension (`ontology_mcp_token`, Key Vault reference). Every tool
   declares the gateway's caller fields (`_agent`, `_task`, `_requestedBy`), so each event records the agent the gateway
   verified, the task and the person. The extension owns the upstream `onto`; `scripts/liquid/setup.mjs` re-points
   `erp`/`crm` (same names: allow-lists and AGENTS.md stay valid) and `--restore` points them back to the mock.
7. **REST:** `GET /objects/:class[/:id]`, `POST /actions/:name` (same pipeline), `GET /kpi`; the parity runner's view
   `/internal/sim/{kpi,log,notices,state,reset,scenario/:id/start}`, proxied by the control plane under
   `/api/liquid/sim/*` (reset and scenarios audited). `run.mjs --backend onto` uses it.

## Consequences

- Input validation is stricter than the mock only where the mock's own tool schema already forbids the input (e.g. an
  unknown factory outside the declared enum); the parity test lists these cases explicitly.
- The T0 projection comes from the domain package's initial world — the same data the extract wrote to the lake. Loading
  T0 from the lake through `bindings.yaml` is the projection migration of M8.
- D1 with real agents (model runs) is the remaining part of the demonstration; deterministic parity and an agent call
  through the gateway are verified.
