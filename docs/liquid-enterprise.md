# Liquid Enterprise: an architecture that adapts within guardrails

*Business data in open formats you own, its meaning in a versioned ontology, rules as code — and everything above that
replaceable.*

Liquid Enterprise is an **optional extension** of the platform. It adds the data half to the agent half: an open lake
and an append-only event log, a LinkML ontology that is compiled into every layer, an ontology server as the only write
path, policy as code, holdable business workflows, a config repository with reviewed proposals, and playbooks that
tighten automatically and loosen only with a human decision.

- Decision record: [ADR-0038](adr/0038-liquid-enterprise-extension.md) (and ADR-0039 … ADR-0049, one per milestone).
- Implementation plan: [liquid-enterprise-extension.md](liquid-enterprise-extension.md).
- Why LinkML, and how a requirement travels from data to ontology to logic and UI: [link-ml.md](link-ml.md).

> **Status:** under construction. Sections marked *(planned)* describe what the named milestone delivers; the
> [implementation log](#appendix-implementation-log) says what exists today.

## Contents

1. [Overview](#overview)
2. [Activation](#activation)
3. [Architecture](#architecture)
4. [Ontology and IR contract](#ontology-and-ir-contract)
5. [Ontology editor](#ontology-editor)
6. [Policies](#policies)
7. [Business workflows](#business-workflows)
8. [Config repository and proposals](#config-repository-and-proposals)
9. [Playbooks](#playbooks)
10. [Identity and apps](#identity-and-apps)
11. [Operations runbook](#operations-runbook)
12. [Results D1–D3](#results-d1d3)
13. [Appendix: implementation log](#appendix-implementation-log)

## Overview

<img src="diagrams/20-liquid-layers.svg" alt="Liquid Enterprise layers: what is owned, what is replaceable" width="100%">

| Layer | Role | Implemented by |
|---|---|---|
| Data lake and event log | raw, immutable data in open table formats; append-only events | Postgres event log + DuckLake (catalog in Postgres, Parquet files), written and queried with DuckDB 2 |
| Ontology and actions | object types, links, typed actions; the **only write path** | LinkML schema + `actions.yaml` + `bindings.yaml` → compiler → ontology server |
| Policy | who may run which action on which object | OPA at the MCP gateway and the ontology server |
| Orchestration | long-running business processes, playbook runs, replays | Temporal, namespace `business` |
| Agents | work on tasks with skills and memory | existing agent containers via the MCP gateway |
| UIs | many small, generated apps | generated TypeScript SDK + app registry |
| Control loop | sense → decide → act with autonomy tiers | config repository + playbooks + shadow replay |

The rules that hold everywhere (plan §1.3): nothing above the ontology binds to physical tables; actions are the only
write path; raw data is immutable and the projection can be rebuilt from events; one source compiled everywhere; fail
closed; tighten automatically, loosen only with approval; desired state in Git.

**Why DuckDB next to Postgres?** Postgres is the operational store: the event log is written in the same transaction as
an action, and the projection serves lookups. DuckDB (embedded in the ontology server, no container of its own) writes
the open-format copy (DuckLake: Parquet files that any engine can read without our code) and runs historical scans and
time travel without loading the operational database. The DuckLake catalog itself lives in the same Postgres.

### Roadmap

<img src="diagrams/22-liquid-milestones.svg" alt="Milestones and dependencies" width="100%">

## Activation

Decision record: [ADR-0039](adr/0039-extension-manager.md).

<img src="diagrams/21-extension-install.svg" alt="Installing an extension from the admin console" width="100%">

**Install from the admin console** (Platform.Admin): **Extensions** → *Liquid Enterprise* → **Install**.

1. The control plane checks Docker and the images (public images are pulled, the extension's own images must be built
   once with `node scripts/stack.mjs build --liquid`; the card says when they are missing).
2. It generates the extension's secrets, creates its data volumes and starts its services in dependency order, waiting
   for each to be healthy.
3. It runs the bootstrap steps (with *Seed the sofa-company demo data*, also the demo seed) and registers the gateway
   upstreams the extension owns.

| Installing | Installed |
|---|---|
| ![Install in progress: steps and service state](images/liquid/extensions-installing.png) | ![Installed: services, steps, Repair and Uninstall; the Liquid enterprise nav group appears](images/liquid/extensions-installed.png) |

Every step is shown with its state; a failed step shows its error and **Retry install** continues from there. An install
interrupted by a restart of the control plane resumes by itself. While installed and healthy, the navigation shows a
**Liquid enterprise** group. **Repair** re-creates missing or changed containers and starts stopped ones (data and
secrets are kept). **Uninstall** removes the upstreams it registered and its containers; *also delete its data volumes
and secrets* removes everything.

What gets created:

| Resource | Name | Notes |
|---|---|---|
| containers | `cw-ext-liquid-<service>` | labels `cw.role=extension`, `cw.extension=liquid`; network `coworking`, host name = service name; no host ports |
| volumes | `cw-ext-liquid-<volume>` | label `cw.role=extension-data` |
| secrets | `DATA_DIR/admin/extensions-secrets.json` (0600) | upstream credentials also in Key Vault as `ext-liquid-<secret>` |
| state | `DATA_DIR/admin/extensions.json` | phase, steps of the last operation, owned upstreams |

Services so far: `ontology-db` (Postgres 17.6: event log, lake catalog, later the projection) and `ontology-server`
(event log owner and lake writer, from M3 the only write path). The list grows with each milestone.

**Compose overlay** (development and CI): the same services under the same names, secrets from `.env`.

```bash
node scripts/stack.mjs liquid up      # = docker compose -f docker-compose.yml -f docker-compose.liquid.yml up -d
node scripts/stack.mjs liquid down    # removes the liquid services, restarts the control plane without the overlay
node scripts/stack.mjs liquid reset   # also deletes the overlay's volumes
```

The **Overview** page (Liquid enterprise → Overview) shows the installation and which layers are live:

![Liquid enterprise overview](images/liquid/liquid-overview.png)

In overlay mode the Extensions page shows Liquid read-only. Use one mode at a time: `liquid up` refuses to start while a
console install exists. `node scripts/stack.mjs reset` removes both.

## Architecture

Decision record: [ADR-0040](adr/0040-lake-ducklake-event-log.md).

<img src="diagrams/23-liquid-data-flow.svg" alt="Data foundation: event log, flush and lake" width="100%">

### Event log

Table `events` in `ontology-db` (Postgres 17.6). Every change to business data is an event; from M3 only the action
pipeline writes them. Appends are zod-validated, written in one statement and idempotent by `event_id`. A trigger
rejects `UPDATE`, `DELETE` and `TRUNCATE` for every role: corrections are new events.

| Column | Meaning |
|---|---|
| `seq` | position in the log (bigserial); the lake's high-water mark |
| `event_id` | uuid, unique; a repeated append returns the existing `seq` |
| `type`, `object_type`, `object_id` | e.g. `SupplierNoticeIssued`, `Supplier`, `S-NORDHOLZ` |
| `action`, `actor_agent`, `actor_user`, `task_id`, `workflow_id` | who and what caused it (filled by the action pipeline, M3) |
| `payload` | jsonb |
| `occurred_at`, `recorded_at`, `ontology_version` | when it happened, when it was stored, under which ontology version |

### Lake (raw zone)

A DuckLake database: catalog in Postgres schema `lake_catalog`, data as Parquet files in the volume
`cw-ext-liquid-lake-data` (`/lake`), written and read by DuckDB 2 inside the ontology server. Data inlining is off,
so every table is real Parquet files.

| Table | Content |
|---|---|
| `raw.events` | the flushed event log (same columns) |
| `raw.erp_*` | factories, machines, workers, absences, materials, bom, suppliers, inventory, purchase_orders, production_orders, maintenance_tickets |
| `raw.crm_*` | customers, orders, campaigns, demand |
| `raw._extracts` | one row per source system extract (`sofa-T0`: the sofa company's initial state) |

Each extract row carries `_extract_id` and `_extracted_at`. Raw tables are never updated.

**Flush:** every 60 s (and on demand) the ontology server appends the events after the lake's high-water mark
(`max(seq)` in `lake.raw.events`) as one snapshot. A gap in `seq` stops the batch until it is 60 s old (the missing
number then belonged to a rolled-back insert), so a slow transaction is never skipped. Running the flush twice adds
nothing.

**Seed:** with *Seed the sofa-company demo data*, the install step `seed-sofa` writes the extract `sofa-T0` from
`packages/sofa-domain` (a port of the mock's initial state, checked against the mock by a test).

### Ontology server: the only write path

Decision record: [ADR-0043](adr/0043-ontology-server-action-pipeline.md).

Every change to business data goes through one pipeline, for agents (MCP through the gateway) and for apps (REST):

1. **Validate** the input with the generated schema of the action.
2. **Policy** hook (allow until M4; fail closed when configured).
3. Run the action on a **copy** of the state (the domain logic, `packages/sofa-domain`).
4. A failed precondition (e.g. "Supplier S-NORDHOLZ cannot deliver at the moment") is answered — **nothing is written**.
5. A success is **one transaction**: append the event with input, answer and the changed objects, update the projection.

Read-only actions never write. Each event records the agent the gateway verified, the task and the person
(`actor_agent`, `task_id`, `actor_user`).

| Endpoint | Who | What |
|---|---|---|
| `/onto/mcp` | agents via gateway upstream `onto` (owned by the extension) | all 31 actions as MCP tools |
| `/erp/mcp`, `/crm/mcp` | agents via upstreams `erp`/`crm` after `scripts/liquid/setup.mjs` | the parity groups — same tools as the mock |
| `/objects/:class`, `/actions/:name`, `/kpi` | control plane, SDK/apps (M9) | REST over the same pipeline |
| `/api/liquid/sim/*` (control plane) | parity runner | KPI, write log, notices, reset, scenarios — as events |
| `/api/liquid/projection/rebuild`, `/dq` | operators | rebuild and data-quality checks |

**Projection:** schema `projection` in `ontology-db` (generated DDL, one table per class, plus `company_meta`). It is a
cache: `POST /api/liquid/projection/rebuild?dryRun=true` rebuilds it from T0 and the event log into a scratch schema and
compares row hashes; without `dryRun` the rebuilt schema is swapped in.

**Backend swap (D1):**

```bash
node scripts/liquid/setup.mjs                    # erp/crm → ontology server (same upstream names)
node scripts/sofa-company/run.mjs --backend onto --no-shots --prefix onto-1
node scripts/liquid/setup.mjs --restore          # erp/crm → mock
```

The Overview page shows the event log, the flush state and every raw table:

![Liquid overview with event log and lake](images/liquid/liquid-overview-lake.png)

## Ontology and IR contract

Why LinkML is the bridge between LLM proposals and generated code, with a worked example: [link-ml.md](link-ml.md).

Decision record: [ADR-0041](adr/0041-ontology-linkml-ir-generators.md).

**Source** — `ontology/sofa/`, three files, the only place where the meaning of business data is written down:

| File | Content |
|---|---|
| `schema.yaml` | LinkML schema: 19 classes with class-local attributes, 12 enums, links (attributes whose range is a class), one identifier per class |
| `actions.yaml` | 31 typed actions (exactly the tools of the sofa mock) with kind, read-only/destructive flags, input fields, named preconditions and emitted events; the event catalog (19 events, incl. the scenario disruptions) |
| `bindings.yaml` | 15 classes bound to their raw-zone tables (`lake.raw.erp_*`, `lake.raw.crm_*`) with key and column mapping; the other classes exist only through actions |

Annotations the compiler requires on every class:

| Annotation | Values | Used by |
|---|---|---|
| `criticality` | `normal`, `business_critical`, `payment_critical` | policy (e.g. four eyes for agent writes on payment-critical objects, M4), blast radius (M7) |
| `data_class` | `public`, `internal`, `confidential` | policy, app registry (M9) |
| `owner` | a role, e.g. `head-of-logistics` | approves structural changes of the class (proposals, M6) |
| `mcp_group` | `erp`, `crm` | tool groups of the parity phase (M3) |

**Compiler** — `tools/ontology-compiler` (Python, LinkML 1.12.1, pinned image `coworking/ontology-compiler:local`;
its tests run in the image build). It validates all references and rules and reports every error with its path, for
example `actions.yaml#create_purchase_order.emits: unknown event 'PurchaseOrderMade'`.

**IR (the contract)** — `packages/ontology-sofa/ir/ontology.ir.json`, schema in `packages/ontology-ir`: name, semver,
enums, classes (attributes with range kind, required, multivalued, identifier), links, events, actions, bindings,
SHA-256 of each source file and a content hash over canonical JSON. Generators read only the IR. The TypeScript side
recomputes the hash and rejects an edited IR.

**Generated** (pure functions IR → files, `packages/ontology-codegen`; every file starts with `GENERATED from ontology
sofa@0.1.0 (<hash>) — do not edit`):

| Artefact | File | Used by |
|---|---|---|
| zod schemas + TS types per enum, class, action input | `packages/ontology-sofa/src/generated/types.ts` | ontology server (validation, M3), SDK |
| MCP tool definitions | `…/src/generated/mcp-tools.ts` | ontology server `/onto/mcp`, `/erp/mcp`, `/crm/mcp` (M3) |
| data-quality checks | `…/src/generated/dq.ts` | projection checks (M3), ontology validation (E2) |
| SDK client | `…/src/generated/sdk.ts` | UIs (M9) |
| projection DDL | `packages/ontology-sofa/generated/projection.sql` | projection in `ontology-db` (M3) |
| OPA data + Rego test skeleton | `…/generated/opa/` | policy bundle (M4) |

**Changing the ontology** (until proposals exist, M6): edit the YAML, then

```bash
node scripts/liquid/ontology-build.mjs --verify   # compile (twice, must be identical) and regenerate
node scripts/liquid/check.mjs                     # includes the stale check: sources ↔ IR ↔ generated files
```

and commit sources, IR and generated files together. Versioning: patch for descriptions/annotations, minor for
additive changes, major for removals or narrowing (enforced from M8). Why this matters, with a worked example from data
to UI: [link-ml.md](link-ml.md).

## Ontology editor

Decision record: [ADR-0042](adr/0042-ontology-editor-react-flow.md).

Admin console → Liquid enterprise → **Ontology** shows the ontology the ontology server is running on (React Flow):

- **Nodes** are classes: name, criticality (orange: business critical, red: payment critical), a lock for confidential
  data, scalar and enum fields (key icon = identifier, bold = required), and the number of read and write actions.
- **Edges** are links, from the referencing class to the referenced one; dashed = optional, `[*]` = multi-valued.
- **Search and filters** (group, criticality) dim everything that does not match.
- **Selecting a class** zooms to it and its linked classes and shows attributes, incoming links, actions with their
  preconditions and events, and the raw table it is bound to. Without a selection the panel shows version, hash, counts,
  enums and company-wide actions.
- Dragged positions are remembered in the browser; **Reset layout** returns to the automatic layout.

| Graph | Selected class | Filter |
|---|---|---|
| ![Ontology graph](images/liquid/ontology-graph.png) | ![Selected class](images/liquid/ontology-selected.png) | ![Filter by criticality](images/liquid/ontology-filter.png) |

E1 is read-only. Next: drafts and validation in the editor (E2), proposals with a diff graph (E3, with M6), the
compatibility class and live apply (E4, with M8).

## Policies

*(planned, M4)*

## Business workflows

*(planned, M5)*

## Config repository and proposals

*(planned, M6)*

## Playbooks

*(planned, M7)*

## Identity and apps

*(planned, M9)*

## Operations runbook

All `/internal` routes of the ontology server need its token; from the host, run them inside the container:

```bash
# flush now / lake status
docker exec cw-ext-liquid-ontology-server node -e "fetch('http://127.0.0.1:7710/internal/lake/flush',{method:'POST',headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(r=>r.text()).then(console.log)"
docker exec cw-ext-liquid-ontology-server node -e "fetch('http://127.0.0.1:7710/internal/lake/status',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(r=>r.text()).then(console.log)"

# read-only SQL over the lake (single SELECT)
docker exec cw-ext-liquid-ontology-server node -e "fetch('http://127.0.0.1:7710/internal/lake/query',{method:'POST',headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify({sql:process.argv[1]})}).then(r=>r.text()).then(console.log)" "SELECT id, name, rating FROM lake.raw.erp_suppliers"

# the event log directly (read only!)
docker exec -it cw-ext-liquid-ontology-db psql -U onto -d onto -c "SELECT seq, type, object_id, occurred_at FROM events ORDER BY seq DESC LIMIT 20"
```

- **Re-seed:** the seed is idempotent by extract id; it only writes again after *Uninstall* with *delete data*.
- **Lake files outside the platform:** the Parquet files are in the volume `cw-ext-liquid-lake-data` under
  `raw/<table>/`; any Parquet reader can open them, and DuckDB with the `ducklake` extension can attach the catalog.
- **Failed install:** the Extensions page shows the failed step and its error; *Retry install* continues there,
  *Repair* re-runs all steps and re-creates containers whose image was rebuilt.
- **Rebuild the projection:** `POST /api/liquid/projection/rebuild?dryRun=true` (verify: `identical` must be true), then
  without `dryRun` to swap. **Data quality:** `GET /api/liquid/projection/dq`.
- **Switch the sofa agents' backend:** `node scripts/liquid/setup.mjs` (ontology server) / `--restore` (mock).
- *(planned)* Replaying a window, restoring after a playbook run, rotating the ontology DB credentials.

## Results D1–D3

*(planned, M3 and M10)*

| # | Demonstration | Status |
|---|---|---|
| D1 | Backend swap: sofa scenarios against the ontology server | open |
| D2 | New security risk: automatic containment, human-gated recovery | open |
| D3 | New business requirement: ontology extension compiled into all layers | open |

## Appendix: implementation log

One entry per milestone. Template:

```
### Mx — <title> (<date>)
Done:        what was built
Verified:    tests, scripts, manual checks (with numbers)
Open:        what is left
Deviations:  from the plan, with the ADR that records them
```

### M0 — Baseline and conventions (2026-11-16)

Done
- Branch `liquid-enterprise` from `79ac9c6`. Plan updated to v1.1 (M0b extension manager, editor tracks E1–E4, this
  document, ADR numbering in creation order). [ADR-0038](adr/0038-liquid-enterprise-extension.md).
- `scripts/liquid/check.mjs` (build, typecheck, tests; `opa test` and the stale-generated check switch on once their
  inputs exist) and `scripts/liquid/baseline-summary.mjs` (KPI table + spread from scenario results).

Verified
- Build green; **31 test files, 214 tests, all passing** (the plan's "88 tests" was out of date). `check.mjs` green.
- The plan's command `corepack pnpm -r build` fails on machines where `pnpm` is only available through corepack:
  `-r` includes the root package, whose `build`/`test` scripts call bare `pnpm`. `check.mjs` runs the package scripts
  with `--filter !coworking-agents` instead.

KPI baseline, run 1 (existing results `scripts/sofa-company/results/s1…s5`, recorded before this branch):

| scenario | late before → after | sofas late after | customers not informed | spend € | tasks | decisions | write calls | guard halts |
|---|---|---|---|---|---|---|---|---|
| supplier-beams | 13 → 0 | 0 | 0 | 42 450 | 1 | 1 | 2 | 0 |
| machine-failure | 9 → 2 | 220 | 2 | 9 650 | 4 | 4 | 4 | 0 |
| demand-spike | 0 → 8 | 970 | 8 | 0 | 4 | 5 | 9 | 2 |
| sick-leave | 7 → 0 | 0 | 0 | 5 200 | 3 | 3 | 1 | 1 |
| storm | 8 → 0 | 0 | 0 | 87 720 | 3 | 3 | 6 | 0 |

(demand-spike: the incident snapshot is taken before the extra demand is planned, so "before" is 0.)

Open
- Runs 2 and 3 per scenario (real model, about 15 runs of up to 45 min) to get the spread. Needed before the D1 parity
  judgement in M3, not for M0b–M2. Store as `results/baseline-<n>-<scenario>.json`.

Deviations
- Exit criterion "baseline with spread" is only partly met (n = 1); see Open.

### M0b — Extension manager and install UI (2026-11-16)

Done
- `packages/extensions`: manifest schema with reference checks, dependency order, environment rendering and masking,
  install/uninstall steps, fingerprint, plan diff, API types.
- `apps/admin-server/src/extensions/`: Docker runtime for labelled extension containers, `ExtensionService` (persisted
  state machine, idempotent steps, resume on start, repair, owned upstreams, secrets 0600 + Key Vault refs, runtime
  availability), API router, `requireExtension` middleware, liquid manifest (`ontology-db`).
- Admin console: Extensions page (install / retry / repair / uninstall with purge option, step progress, services,
  logs; Signals read-only), Liquid overview page, nav groups in `AppShell` (`NavItem.group`).
- `docker-compose.liquid.yml`, `stack.mjs` (`build --liquid`, `liquid up|down|reset`, `reset` removes extension
  resources, `LIQUID_ONTOLOGY_DB_PASSWORD` in `.env`), Dockerfile includes the new package. [ADR-0039](adr/0039-extension-manager.md).

Verified
- `check.mjs` green: build, typecheck, tests. New tests: 16 in `packages/extensions` (validation table, order,
  rendering, masking, steps, fingerprint, diff), 22 in `admin-server` with a fake Docker (install order, demo-only steps,
  secrets not in state file, Key Vault reference vs. plain header, missing local image → build hint, third-party pull,
  upstream name collision, health wait and timeout, concurrent operation refused, retry from failed step without
  re-creating healthy services, resume after restart, repair, uninstall only touches own resources, purge, overlay mode,
  Docker status parsing, manifest ↔ overlay service parity).

- **End to end** (`node scripts/liquid/e2e-extension.mjs`, result `scripts/liquid/results/m0b-extension-e2e.json`):
  15/15 checks on the running stack. The control plane was restarted while `service:ontology-db` was running; the
  install resumed and finished by itself. Container labelled and healthy, volume created, `psql` answers, install
  audited, nav route offered, repair keeps the healthy container, uninstall with purge leaves no container, volume or
  owned upstream. Screenshots in `docs/images/liquid/`.

Open
- Nothing for M0b.

Deviations
- None from the plan. The pino logger already redacts any `env` field; the masked environment is logged anyway.
- Found and fixed on the way: `infra/docker/Dockerfile` (from commit `79ac9c6`, Signals) had a literal `
` instead of a
  line continuation in the `pnpm deploy` step, so no image could be built from that commit (`/bin/sh: n: not found`).
- The control plane was rebuilt with `docker compose build temporal` + `up -d --no-deps temporal`, not `stack.mjs up`,
  because `up --remove-orphans` would remove services of other overlays (e.g. the running `mcp-sofa`).

### M1 — Data foundation: event log and lake (2026-11-16)

Done
- Spike: MinIO no longer viable (no community images since October 2025); SeaweedFS + Iceberg REST catalog dropped as
  too many moving parts. **DuckLake** on DuckDB 2 (2.0.0) works on Windows and in the Linux image: Postgres catalog in
  its own schema, Parquet data files, snapshots, time travel, extensions installed at build. [ADR-0040](adr/0040-lake-ducklake-event-log.md).
- `packages/lake`: event store (validated, idempotent, append-only trigger), gap-safe flush, DuckLake writer/reader
  (extracts in one transaction, read-only query, status, Parquet file counts).
- `packages/sofa-domain`: the mock's initial world in TypeScript plus the raw extract (15 tables). The mock exports
  `freshWorld` and its constants and only starts its server when run directly.
- `apps/ontology-server` (M1 part): internal API, flush loop, image with DuckDB extensions preinstalled.
- Liquid manifest + overlay: `ontology-server` with volume `lake-data`, internal token, demo-only bootstrap step
  `seed-sofa`. Admin API `GET /api/liquid/lake`, "Event log and lake" card on the Overview page.
- Extension manager: the image id is now part of the service fingerprint, so *Repair* re-creates a container whose
  `:local` image was rebuilt.
- Diagrams: milestones (`22-liquid-milestones.svg`), data flow (`23-liquid-data-flow.svg`).

Verified
- `check.mjs` green. New tests: sofa-domain 5 (world and constants identical to the mock, extract shape), lake 15
  (idempotent append, invalid input writes nothing, UPDATE/DELETE/TRUNCATE rejected, gap table, 1,000 events flushed
  twice = 1,000 rows, continuation, field round trip, query guard, seed round trip, every table as Parquet, time
  travel), ontology-server 5 (health, auth, append + flush + status, seed once with counts equal to the extract,
  validation), admin-server +1 (rebuilt image re-created on repair).
- **End to end** on the stack (`node scripts/liquid/e2e-lake.mjs`, result `scripts/liquid/results/m1-lake-e2e.json`):
  10/10 — install with seed; raw-zone counts equal to the **mock's** initial state (not only our port); a DuckDB query
  over the raw zone matches the mock (18 orders, 1,800 sofas, 3 beam suppliers); 1,000 events flushed twice = exactly
  1,000 rows; UPDATE on `events` rejected; every non-empty raw table stored as Parquet; catalog in `lake_catalog`.
- **Overlay path:** `stack.mjs liquid up` started both services healthy, the console switched to overlay mode and read
  the lake with the `.env` secrets, the seed worked; `liquid down` removed them and restarted the control plane
  without the overlay; `mcp-sofa` of the sofa overlay kept running. Reinstall from the console kept the data of the
  earlier install (uninstall without purge).

Deviations
- Plan said MinIO + Iceberg (later SeaweedFS); built DuckLake on Postgres with no extra containers (ADR-0040, decided
  with the user). DuckDB 2.0.0 instead of the 1.5 line (user's choice).
- The flush is a loop in the ontology server, not a Temporal schedule; it moves to one in M5.
- Found on the way: DuckLake inlines small inserts into the catalog by default — switched off
  (`DATA_INLINING_ROW_LIMIT 0`); already inlined data is moved to Parquet at startup. `stack.mjs liquid down` passed
  volume names as services — fixed.

Open
- Baseline runs 2 and 3 (before M3).

### M2 — Ontology and compiler, editor E1 (2026-11-16)

Done
- `ontology/sofa`: LinkML schema (19 classes, 12 enums, annotations), `actions.yaml` (31 actions = every mock tool,
  event catalog of 19 events), `bindings.yaml` (15 classes onto the M1 raw tables).
- `tools/ontology-compiler`: LinkML 1.12.1 SchemaView → IR; collected, path-addressed errors; CLI and HTTP mode;
  pinned image with tests in the build. [ADR-0041](adr/0041-ontology-linkml-ir-generators.md).
- `packages/ontology-ir`: IR schema, canonical hash (identical to Python), reference checks, browser entry, `irToGraph`.
- `packages/ontology-codegen`: generators for types, MCP tools, DQ checks, SDK, projection DDL, OPA data; CLI with
  `--check`. `packages/ontology-sofa`: IR + generated artefacts.
- `scripts/liquid/ontology-build.mjs` (`--verify`: two compiles, identical bytes) and `check-generated.mjs` (in
  `check.mjs`).
- Editor E1: `/liquid/ontology` with React Flow 12.12.1 and dagre; IR served by the ontology server and passed through
  the control plane. [ADR-0042](adr/0042-ontology-editor-react-flow.md).
- [docs/link-ml.md](link-ml.md) and diagram `24-linkml-bridge.svg`.

Verified
- Build deterministic: two compiler runs give the same bytes (hash `47c5052c5079`); the container output equals a local
  LinkML run.
- Compiler tests 15 (validation errors, determinism, hash coverage, canonical form). IR tests 9 (TS hash = Python hash,
  stale source detection, edited IR rejected, dangling reference rejected, graph view). Codegen tests 7 on a synthetic
  ontology. Sofa package tests 38: **generated MCP tools equal the mock's tools one to one** (31 tools: groups, names,
  read-only/destructive hints, fields, types, required, enums, descriptions), **DDL applies to an empty Postgres**, DQ
  checks pass on consistent data and catch a dangling multi-valued link, the DDL rejects bad enums and dangling links,
  generated types validate real objects, generated files are not stale.
- Stale check negative test: editing `schema.yaml` without a rebuild makes `check-generated.mjs` fail.
- **End to end** (`node scripts/liquid/e2e-ontology.mjs`, result `scripts/liquid/results/m2-ontology-e2e.json`): 7/7 —
  repair picked up the new images, the nav offers the Ontology page, the ontology server serves the committed IR (same
  hash), React Flow renders 19 nodes and 21 edges, selecting a class shows its details and source table.

Deviations
- DQ checks on the *seeded projection* move to M3 (the projection is built there); in M2 they run against a test
  projection.
- `pnpm ontology:build` is `node scripts/liquid/ontology-build.mjs` (root `package.json` untouched).
- The SDK lives in `packages/ontology-sofa` until M9 publishes `packages/liquid-sdk`.
- Editor E2 (drafts and validation) is done with M3 instead of M2.

### M3 — Ontology server and backend swap (2026-11-16)

Done
- `packages/sofa-domain`: the mock's logic ported 1:1 (`SofaCompany`: capacity, simulation, KPI, scenarios, 31 tools);
  world ⇄ ontology objects (lossless), diff and apply of changes.
- Ontology: attributes the mock uses added (sales-order source, ticket technician/opened, incident claim/filed, notice
  recipient/sent); DDL generator adds `ord` and applies foreign keys idempotently.
- `apps/ontology-server`: action pipeline (validation, policy hook, copy-on-write handler, one transaction for event +
  projection), projection store (T0 seed, upserts, rebuild + atomic swap, row hash, DQ), MCP `onto`/`erp`/`crm` with caller
  identity, REST, simulation control as events. [ADR-0043](adr/0043-ontology-server-action-pipeline.md).
- Extension: MCP token, owned upstream `onto`; control-plane routes `/api/liquid/sim/*`, `/projection/*`;
  `scripts/liquid/setup.mjs` (swap/restore); `run.mjs --backend onto`.

Verified
- **Deterministic parity:** 6 states (baseline + 5 scenarios) × 57 calls — every answer byte-identical to the mock,
  plus world, id sequences, write count and KPI (sofa-domain tests). The same through the full pipeline against Postgres;
  the only input the generated schema rejects is one the mock's own schema forbids (`get_capacity` with an unknown
  factory).
- Pipeline tests (PGlite): read-only never writes, invalid input and failed preconditions write nothing, a failing
  transaction rolls back completely, the policy hook denies, events carry caller and changes, rebuild is identical and
  swaps, reset restores T0, the write log restarts, DQ passes on the seeded projection (the M2 criterion), MCP groups and
  caller fields.
- Found by the tests: the generated DDL was not idempotent (foreign keys) — the server would have failed on its second
  start; fixed in the generator, the sofa package test now applies the DDL twice.
- **End to end** (`node scripts/liquid/e2e-backend.mjs`, `scripts/liquid/results/m3-backend-e2e.json`): 13/13 — the
  gateway lists 31 `onto__` and 31 `erp__/crm__` tools from the ontology server; agent Lara's calls **through the gateway**
  answer byte-identically to the mock (read, write, failed precondition, KPI); exactly one event, with `actor_agent
  sofa-lara`; KPI equals the mock; rebuild identical; 112 DQ checks pass on the live projection; events reach the lake.

Open
- **D1 with the real model:** baseline runs 2 and 3 on the mock and the five scenarios with `--backend onto` (about 15
  runs of up to 45 min, model costs) — to be scheduled; until then D1 rests on deterministic parity and the agent call
  through the gateway.

Deviations
- Editor E2 (drafts + validation) moves to M6 together with E3 (a draft is only useful once it can become a proposal).
- T0 of the projection comes from the domain package's initial world (the same data as the lake extract); loading it
  through the bindings is part of the projection migration in M8.

### Later

Ideas that are out of scope for now (plan §7, "scope creep").
