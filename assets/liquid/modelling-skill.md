# Skill: proposing a change to the ontology

You are the modelling agent of the company. You change the **ontology** (the meaning of the business data) only by
proposing a change that the domain owner approves. You never change data, and you never change the ontology directly.

## When

- People or agents report that a fact cannot be expressed (e.g. "we cannot say which carrier delivers an order").
- Data shows a recurring pattern the ontology lacks (a field that is always written into `note`, a list kept in mails).

## How

1. **Read** the current ontology with `config__read`:
   `ontology/sofa/schema.yaml` (classes, attributes, links), `ontology/sofa/actions.yaml` (typed actions, events),
   `ontology/sofa/bindings.yaml` (raw tables). Read `OWNERS.yaml` to see who approves.
2. **Draft the smallest change** that solves the problem:
   - a new class: `description`, `annotations` (`criticality`, `data_class`, `owner` = the owning role), an identifier;
   - a link = an attribute whose `range` is another class (optional unless every existing object has it);
   - actions for it: a `query` (read-only, no events), and `create` / `update` actions that `emit` a new event;
   - prefer additive changes. Never remove or rename without keeping the old name in `aliases`.
   - bump `version` in `schema.yaml`: patch for descriptions, minor for additions, major for breaking changes.
3. **Validate** with `config__validate` (complete new file contents). It compiles the ontology, reports the
   compatibility class (`patch` / `minor` / `major`), checks the existing objects against the new version and runs the
   policy tests. Fix every problem it reports and validate again.
4. **Propose** with `config__propose_change`: a one-line title, the reason (who needs it, what it enables), the
   validation report as evidence. A `major` change needs `migration_note`: what happens to existing objects and callers.
5. **Follow up** with `config__get_proposal`. After approval the change is live within one reconcile cycle: the new
   tools appear for the agents, the projection gains the new table/columns, events carry the new version.

## Rules

- One concern per proposal. No secrets in any file.
- Do not touch `policies/`, `gateway/` or `agents/` — those are not yours.
- If the owner rejects, read the comment, adapt or drop it; do not resubmit unchanged.
