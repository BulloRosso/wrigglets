# ADR-0042: Ontology editor in the admin console with React Flow

- **Status:** Accepted (E1 implemented; E2–E4 planned)
- **Date:** 2026-11-16
- **Extends:** [ADR-0041](0041-ontology-linkml-ir-generators.md)

## Context

People who own business data (the `owner` annotation) must understand the ontology and approve its changes; agents
propose changes as LinkML diffs. Reading YAML is fine for developers, not for a head of logistics. The console needs a
visual view of classes, links and actions, and later a way to draft changes that go through the same governed path as
agent proposals.

## Decision

1. **Library:** `@xyflow/react` 12.12.1 (MIT) for the canvas, `@dagrejs/dagre` 3.1.3 (MIT) for auto-layout (elkjs was
   the alternative; its EPL-2.0 licence is not needed). 13.0 of React Flow was released on the day of the decision and
   is not used yet.
2. **Data path:** the ontology server serves the IR it runs on (`GET /internal/ontology`), the control plane passes it
   through (`GET /api/liquid/ontology`, Platform.Admin, 404 while the extension is unavailable). The editor shows what is
   actually running, not a file in the repository.
3. **E1 — viewer** (`/liquid/ontology`): a pure `irToGraph` in `@cw/ontology-ir` (tested) builds nodes and edges; the
   page maps them onto React Flow. A node shows name, criticality, data class, scalar/enum fields (identifier marked)
   and read/write action counts; an edge is a link (dashed when optional, `[*]` when multi-valued). Search, group and
   criticality filters dim non-matching classes; selecting a class highlights its links and shows attributes, incoming
   links, actions with preconditions and events, and the source table with its column mapping. The summary shows
   version, hash, counts, enums and company-wide actions. Node positions are remembered per browser (localStorage,
   guarded); "Reset layout" returns to the dagre layout.
4. **E2–E4 (planned):** drafts as typed operations on the three YAML files (the `yaml` Document API keeps comments and
   order), validation through the compiler's HTTP mode installed as an extension service, errors shown on nodes (E2);
   submit as a proposal with a diff graph from a pure `diffIr` (E3, with M6); compatibility class and live apply (E4,
   with M8). Editor and modelling agent produce the same proposal type.

## Consequences

- The viewer is read-only; nobody can change the ontology from the console until proposals exist (E3), which keeps the
  approval rule intact.
- A second dependency tree (React Flow) is added to the admin console bundle only; other UIs are unaffected.
