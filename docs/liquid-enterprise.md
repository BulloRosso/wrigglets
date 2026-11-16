# Liquid Enterprise: an architecture that adapts within guardrails

*Business data in open formats you own, its meaning in a versioned ontology, rules as code — and everything above that
replaceable.*

Liquid Enterprise is an **optional extension** of the platform. It adds the data half to the agent half: an open lake
and an append-only event log, a LinkML ontology that is compiled into every layer, an ontology server as the only write
path, policy as code, holdable business workflows, a config repository with reviewed proposals, and playbooks that
tighten automatically and loosen only with a human decision.

- Decision record: [ADR-0038](adr/0038-liquid-enterprise-extension.md) (and ADR-0039 … ADR-0049, one per milestone).
- Implementation plan: [liquid-enterprise-extension.md](liquid-enterprise-extension.md).

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

| Layer | Role | Implemented by |
|---|---|---|
| Data lake and event log | raw, immutable data in open table formats; append-only events | MinIO + Apache Iceberg + Postgres event outbox; DuckDB for queries |
| Ontology and actions | object types, links, typed actions; the **only write path** | LinkML schema + `actions.yaml` + `bindings.yaml` → compiler → ontology server |
| Policy | who may run which action on which object | OPA at the MCP gateway and the ontology server |
| Orchestration | long-running business processes, playbook runs, replays | Temporal, namespace `business` |
| Agents | work on tasks with skills and memory | existing agent containers via the MCP gateway |
| UIs | many small, generated apps | generated TypeScript SDK + app registry |
| Control loop | sense → decide → act with autonomy tiers | config repository + playbooks + shadow replay |

The rules that hold everywhere (plan §1.3): nothing above the ontology binds to physical tables; actions are the only
write path; raw data is immutable and the projection can be rebuilt from events; one source compiled everywhere; fail
closed; tighten automatically, loosen only with approval; desired state in Git.

## Activation

*(planned, M0b)* Admin console → **Extensions** → *Liquid Enterprise* → **Install**. The control plane starts the
extension's containers, generates their secrets, registers the gateway upstreams it owns and, if chosen, seeds the sofa
company demo data. **Uninstall** removes the containers and everything the extension registered; *purge data* also
removes its volumes.

The images are built locally once:

```bash
node scripts/stack.mjs build --liquid
```

For development and CI the same services can run as a compose overlay:

```bash
node scripts/stack.mjs liquid up      # docker compose -f docker-compose.yml -f docker-compose.liquid.yml up -d
```

## Architecture

*(planned, M1–M5)*

## Ontology and IR contract

*(planned, M2)* The ontology source, the annotations the compiler reads (`criticality`, `data_class`, `owner`,
`mcp_group`), the IR schema, the generator outputs and the versioning rules.

## Ontology editor

*(planned, E1–E4)* Admin console → Liquid enterprise → **Ontology**: classes as nodes, links as edges, enums and actions
in a side panel. Changes are made in a draft, validated by the compiler, submitted as a proposal and go live after the
owner approves.

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

*(planned)* Rebuilding the projection, replaying a window, restoring after a playbook run, rotating the ontology DB
credentials, repairing a failed install.

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

### Later

Ideas that are out of scope for now (plan §7, "scope creep").
