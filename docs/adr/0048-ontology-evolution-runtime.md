# ADR-0048: Ontology evolution — runtime interpretation, compatibility, live migration

- **Status:** Accepted
- **Date:** 2026-11-16
- **Extends:** [ADR-0041](0041-ontology-linkml-ir-generators.md), [ADR-0043](0043-ontology-server-action-pipeline.md), [ADR-0046](0046-config-repository-proposals.md)

## Context

Plan M8: the ontology must evolve while the system runs, and agents must be able to propose extensions. Until M7 the
ontology server imported code generated from the IR (zod input schemas, MCP tools, projection SQL, DQ checks, OPA
data), so a new ontology version meant regenerating, rebuilding and redeploying. The simplification review (item 5)
proposed interpreting the IR at runtime instead; only the UI SDK needs real code generation.

## Decision

1. **The ontology server interprets the IR in force.** MCP tool schemas, input validation (a zod schema built from the
   IR on first use), projection DDL, data-quality checks and the OPA data are computed from the current IR at runtime
   (the generator functions of `@cw/ontology-codegen` are pure and are called directly). The generated files stay as a
   development aid and for the SDK; they are no longer in the deploy path of a new version.
2. **Compatibility** (`compatibility(a, b)` in `@cw/ontology-ir`): `patch` (descriptions, annotations), `minor`
   (additive: classes, optional attributes, actions, events, enum values, optional inputs, renames that keep the old
   name as an alias), `major` (removals, range or multiplicity changes, optional → required, new required inputs or
   attributes on existing classes, removed aliases). The version in the file must be at least the suggested one.
3. **Proposals** of ontology changes carry the compatibility class; a `major` change needs a **migration note**; the
   ontology server checks the candidate against the existing objects (required attributes empty, enum values in use).
   Agents use `config__validate` before `config__propose_change` (modelling skill).
4. **Live apply.** After a merge the reconciler compiles the ontology of `main` (compiler service) and posts the IR to
   the ontology server, which applies it between two actions (same lock as the action pipeline, no request lost):
   additive → DDL migration in place (new tables, nullable columns, widened enum checks); breaking, or additive with
   existing history for the added class/attribute → rebuild of the projection from the events with the new DDL, then
   swap. Applied versions are stored in `ontology_versions`; a restart loads the last one unless the image brings a
   newer built-in version. The gateway drops its tool cache, so agents see the new tools at once; OPA gets the new
   actions with its next bundle poll; events carry the new `ontology_version`.
5. **Actions without code run generically.** The domain package implements the ontology it was written for; for
   actions a newer version adds, generic handlers derived from the IR do query (filter by inputs), create, update and
   delete. Objects of new classes and new attributes of domain classes are kept as extension state beside the domain
   world, written as events like everything else, and loaded back from the projection.
6. **Aliases and deprecation.** `aliases: [old_name]` on an action keeps the old tool name working (marked deprecated,
   recorded as `viaAlias` in the event); `deprecated: <note>` marks an action that still works. The editor shows both
   struck through.

## Consequences

- The D3 change (class Carrier, link PurchaseOrder.carrier, list/create/assign actions, the role allowed to write them)
  goes from an agent's proposal to live in about a second after approval, with the SDK regenerated (verified).
- New write actions need a role that may write them (the gateway policy fails closed); granting it belongs in the same
  reviewed change.
- Type checking inside generic handlers is weaker than in domain code; complex behaviour still needs code in the
  domain package (a new image), which is then the built-in version.
- Comparisons of projection fingerprints are key-order independent (a migrated column comes last).
