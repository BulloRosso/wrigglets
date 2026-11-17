# ADR-0041: Ontology in LinkML, compiled to an IR, every layer generated from the IR

- **Status:** Accepted; superseded in part by [ADR-0053](0053-liquid-simplification-ii.md) (compiler in TypeScript, no generated code in git)
- **Date:** 2026-11-16
- **Extends:** [ADR-0038](0038-liquid-enterprise-extension.md), [ADR-0040](0040-lake-ducklake-event-log.md)
- **Explainer:** [docs/link-ml.md](../link-ml.md)

## Context

Liquid Enterprise needs one description of what the business data means, from which the storage, the agent tools, the
policy data, the data-quality checks and the UI SDK follow (plan §1.3 invariant 4: one source, compiled everywhere).
Agents will propose changes to it (M8), so it must be easy to read and review for people and LLMs, and the code that
follows from it must be produced deterministically, not written by a model.

## Decision

1. **Source:** `ontology/<name>/` with three files.
   - `schema.yaml` — a LinkML schema (1.12.1): classes with class-local `attributes` (so `status` can have a different
     enum per class), enums, links as attributes whose range is a class, one identifier per class, and the annotations
     `criticality` (normal | business_critical | payment_critical), `data_class` (public | internal | confidential),
     `owner` (role that approves structural changes) and `mcp_group` (parity groups erp/crm).
   - `actions.yaml` — LinkML has no behaviour; typed actions live here: `kind` (query | create | update | delete |
     command), `read_only`, `destructive`, `mcp_group`, `input` fields (scalar, json, enum or class = id), named
     `preconditions`, `emits` (event types). Plus an `events` catalog (incl. the scenario disruptions).
   - `bindings.yaml` — class → raw-zone table (`lake.raw.*`), key, column mapping, named transforms.
   The sofa company has 19 classes, 12 enums, 31 actions (exactly the mock's tools), 19 events, 15 bindings.
2. **Compiler front end** (`tools/ontology-compiler`, Python, LinkML `SchemaView`) produces the **IR**
   (`packages/ontology-<name>/ir/ontology.ir.json`). It validates references and rules and reports **all** errors with
   a path (unknown class/enum/event/attribute, missing identifier or annotation, write action without event, query that
   is not read-only, unknown keys, …). It runs in a pinned image (`python:3.12.12-slim-bookworm`, LinkML 1.12.1) whose
   build runs the compiler's tests, as a CLI (`compile`) and as an HTTP service (`serve`, for the editor in E2).
3. **The IR is the contract** (`packages/ontology-ir`, zod): name, semver, enums, classes (attributes with range kind,
   required, multivalued, identifier), links, events, actions, bindings, the SHA-256 of each source file and a content
   hash over the canonical JSON (sorted keys, no whitespace, UTF-8). The TypeScript side recomputes the hash with the
   same canonical form and rejects an IR whose hash does not match (edited by hand) or whose references dangle. A
   browser entry (`@cw/ontology-ir/browser`) leaves out `node:crypto`.
4. **Generators** (`packages/ontology-codegen`) are pure functions IR → files, written into the ontology package:
   zod schemas and TS types per enum, class and action input; Postgres DDL of the projection (schema `projection`,
   enum CHECKs, deferred foreign keys for single-valued links, `version` and `updated_seq`); MCP tool definitions
   (mock-compatible JSON schemas and hints); OPA data `data.liquid.ontology` with a Rego test skeleton; data-quality
   checks (required, enum, link — including multi-valued links that no foreign key can cover); an SDK client. Every
   file starts with `GENERATED from ontology <name>@<version> (<hash>) — do not edit`.
5. **Build:** `node scripts/liquid/ontology-build.mjs [--verify]` runs compiler → IR → generators; `--verify` compiles
   twice and fails if the bytes differ. **Stale check:** `scripts/liquid/check-generated.mjs` (part of
   `scripts/liquid/check.mjs`, no Docker) fails when a source file changed after the IR was compiled or a generated file
   differs from what the generators produce. IR and generated files are committed.

## Consequences

- Parity with the mock is a test: the generated tool list equals the mock's tools one to one (groups, names, read-only
  and destructive hints, fields, types, required, enums, descriptions).
- The generated DDL applies to an empty Postgres and its DQ checks run on the projection (PGlite in tests). The DQ run on
  the seeded projection moves to M3, when the projection exists.
- The plan's `pnpm ontology:build` is `node scripts/liquid/ontology-build.mjs`; the root `package.json` is left alone.
- The SDK lives in `packages/ontology-sofa` for now; M9 publishes it as `packages/liquid-sdk`.
- Changing the ontology now means: edit YAML, run the build, commit IR and generated files together. From M6 the
  reconciler does this on approved proposals, from M8 with a compatibility check and live reload.
