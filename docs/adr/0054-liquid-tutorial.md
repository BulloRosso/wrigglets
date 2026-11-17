# ADR-0054: A guided tutorial in the console, with a small tutorial API

- **Status:** Accepted
- **Date:** 2026-11-17
- **Extends:** [ADR-0049](0049-liquid-simplification.md) (one approval inbox, Git host), [ADR-0050](0050-entra-option-app-registry.md) (apps), [ADR-0052](0052-acceptance-core-checks-workflow-v2.md) (D3)

## Context

After the install, an evaluator had two scripts (D2, D3) and a long reference document. Nothing let a person see the
core values for themselves on the live platform:

- data you own;
- one ontology;
- rules as code;
- holdable processes;
- change through review;
- automatic containment;
- a requirement end to end.

A click-through also has gaps. These steps had no page of their own:

- creating, cancelling or classifying business objects (agents and apps do that);
- proposing a change that the ontology editor cannot express (an action, a check, a role);
- the Forgejo reviewer password, which exists only in the extension secrets.

## Decision

1. **Liquid enterprise → Tutorial** (`/liquid/tutorial`): seven chapters, one per core value, and a preparation step.
   Each step:
   - links to the page where it is done;
   - computes its state from the live platform with pure functions over the existing APIs (`apps/admin-web/src/tutorial/steps.ts`).

   A step that is only looking at something is ticked by hand. The start is kept in the browser (localStorage
   `cw.liquid.tutorial`). Only state created after the start counts, so earlier runs never tick a box.
   `docs/liquid-tutorial.md` is the same tour with screenshots.
2. **A tutorial API**, Platform.Admin and 404 without the extension (`apps/admin-server/src/liquid/tutorialApi.ts`):
   - `POST /liquid/tutorial/prepare` returns the platform to a calm state: cancels open playbook runs and releases
     their holds, removes playbook and tutorial overlays, enables erp/crm, sets kill switches to normal, and waits
     until the policy engines run the new package. It then resets the simulated company and places three orders in the
     admin's name. Loosening here is console work like any other: audited and committed to the config repository.
   - `POST /liquid/tutorial/action` runs **one of three whitelisted actions** through the core's normal pipeline
     (validation, policy, event):
     - `cancel_purchase_order`, played as agent `sofa-lara`'s call. It carries no person, so the admin can be the
       second pair of eyes;
     - `create_purchase_order` and `set_commodity_risk`, as the admin.

     Other fields, including caller fields, are dropped.
   - `POST /liquid/tutorial/propose/due-diligence` makes the D3 change a person's proposal. It attaches a shadow replay
     of the rule as evidence, and it is reviewed and merged on the Git host like every other proposal. The change is
     built from the live config files and adds only what is missing (`tutorialChanges.ts`).
   - `GET /liquid/tutorial/due-diligence` picks a material and supplier without a valid statement for chapter 7
     (timber from Nordholz first, six pairs). Statements are events and survive simulation resets.
   - `GET /liquid/tutorial/git-host` returns the reviewer login, **but only while the Git host's public URL is on this
     machine** (localhost / 127.0.0.1). On a shared host it returns no credentials: reviewers use their own accounts.
3. **The optional model path.** In chapter 7 the evaluator may give the requirement to `sofa-modeller` instead (created
   with `scripts/liquid/modelling-agent.mjs`, which uses model tokens). Its proposal ticks the same step.
4. **Verification.** `scripts/liquid/e2e-tutorial.mjs` drives every chapter with the calls a click makes (the console
   API, Forgejo as reviewer, the app as the buyer). It reads the tutorial page in a browser and requires every
   chapter's counter to reach *n/n*. It is the last suite of `e2e-all.mjs`. `--shots` refreshes the screenshots in
   `docs/images/liquid/tutorial/`.

## Alternatives considered

- **General pages for business objects or raw config proposals.** Agents and apps are the intended writers of business
  data, and the ontology editor is the intended way to change the ontology. A general console form would be a second
  write path for people that the architecture deliberately does not have. Three whitelisted actions keep the
  tutorial honest and small.
- **Approve proposals in the console during the tutorial.** That would undo ADR-0049's rule that proposals are decided
  on the Git host only. The tutorial shows the reviewer login instead.
- **Tutorial progress on the server.** One evaluator per browser is the common case. Ticks are derived from the
  platform anyway, and only the start and the manual ticks are local.

## Consequences

- The ontology grows by one class and one minor version per run of chapter 5. A rule taken off for a re-run is a
  major version. These versions are history, and the editor and the versions list show them.
- The tutorial API can only tighten, place, cancel or classify orders in the demo company, propose a change, and read
  one secret on a local install. Merges, approvals and every loosening still need a person on the regular pages.
- The D3 change exists twice: in `scripts/liquid/scenario-business.mjs` (the agent's edit) and in `tutorialChanges.ts`.
  A unit test compiles the tutorial's version against the repository's ontology and applies it twice.
