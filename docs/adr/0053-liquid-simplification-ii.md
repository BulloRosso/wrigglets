# ADR-0053: Simplification II — compiler in TypeScript, one deployment path, Forgejo on SQLite, one SDK, job runner, declarative checks

- **Status:** Accepted
- **Date:** 2026-11-17
- **Supersedes in part:** [ADR-0038](0038-liquid-enterprise-extension.md) and [ADR-0039](0039-extension-manager.md) (compose overlay), [ADR-0041](0041-ontology-linkml-ir-generators.md) (Python compiler, checked-in generated code), [ADR-0049](0049-liquid-simplification.md) (compiler service, Forgejo database in Postgres), [ADR-0052](0052-acceptance-core-checks-workflow-v2.md) (overlay with Forgejo; the D3 rule as core code)
- **Extends:** [ADR-0048](0048-ontology-evolution-runtime.md), [ADR-0051](0051-control-loop-health-robustness.md)

## Context

After M10 the extension had every planned feature and passed the complete runtime test. It still had:

- four containers, three locally built images and 14 secrets;
- three languages to maintain: TypeScript, Python (only for the ontology compiler) and Rego;
- two deployment modes: console install and compose overlay. Each had its own bootstrap path, and a test kept the two
  in sync;
- two Postgres databases (the event log and Forgejo's);
- 3,144 lines of generated SDK and types in git, which had to be regenerated for every ontology version, although the
  runtime already serves an SDK computed from the IR in force;
- five background timers in the control plane, each with its own start, stop and status code;
- the D3 rule (`due_diligence_for_high_risk_material`) as TypeScript in the core, switched on by the ontology.

The goal was the same as for ADR-0049: fewer moving parts, without removing a feature or loosening a security default
(fail closed, tighten-only, review on the Git host).

Decisions made with the user before the work started:

| Question | Decision |
|---|---|
| Compose overlay | remove it; the console install is the only path |
| Ontology compiler | port it to TypeScript; drop the Python service |
| Policy language | keep Rego; the static OPA binary moves into the control-plane image |

## Decision

1. **The ontology compiler is TypeScript** (`packages/ontology-compiler`). It compiles the LinkML subset we use:
   - classes with attributes, identifier, required and multivalued;
   - enums with permissible values;
   - annotations;
   - `actions.yaml` and `bindings.yaml`.

   It produces the IR byte for byte as the Python compiler did. The golden test compiles `ontology/sofa` and compares
   it with the committed IR (same content hash). Keys outside the subset fail with *LinkML feature 'x' is not
   supported*, and `imports` accepts only `linkml:types`. The control plane calls it in-process for validation, drafts
   and the reconciler. `scripts/liquid/ontology-build.mjs` and `check-generated.mjs` use the same package.
2. **OPA runs as a binary in the control plane.** The `control-plane` image contains the static OPA 1.22 binary (pinned
   by digest). `opa check`, `opa test` and `opa build -t wasm` run as child processes on a temporary copy of the
   policies, after the paths are validated. The embedded WASM engine in the gateway and the core is unchanged
   (ADR-0049).
3. **One deployment path.** `docker-compose.liquid.yml`, the `LIQUID_*` variables, `stack.mjs liquid up|down|reset` and
   the overlay mode of the extension manager are gone. `stack.mjs build --liquid` builds the one own image
   (`ontology-server`), and `stack.mjs` removes leftover `LIQUID_*` lines from `.env`. Development, CI and the runtime
   test use the console install.
4. **Forgejo uses SQLite** in its own volume (`/data/gitea/forgejo.db`). The `forgejo-db` bootstrap step, the `pg`
   client in the control plane and the `forgejo_db_password` secret are gone; `ontology-db` holds only Liquid's
   schemas.
5. **One SDK, served at runtime.** The generated `types.ts` and `sdk.ts`, the generator CLI and `generateAll` are
   removed from git. The core (`/internal/ontology/sdk.ts`) and the control plane (`/api/liquid/ontology/sdk`) serve the
   app SDK computed from the IR in force. Tests validate inputs with `inputValidator(ir, action)` from
   `@cw/ontology-ir`. The check *ontology IR up to date* compares the committed IR with the compiler output.
6. **One job runner.** `apps/admin-server/src/liquid/jobs.ts` runs the control plane's Liquid loops: config
   reconciler, playbook schedules, audit forwarding into the event log, approvals (wiki mirror and mails) and app
   expiry. All jobs share one gate: the extension is installed and no extension operation is running. Each job
   records its runs, last success, last error and skipped ticks. The health view shows them as *Background jobs*.
7. **Declarative preconditions.** The ontology can define `checks` in `actions.yaml`. A check names:
   - a subject (the object an action input refers to);
   - an optional `when` and a `require` condition;
   - a message.

   Conditions are a closed set: path comparisons (`equals`, `in`, `present`), `exists … where`, and `all`, `any`,
   `not`. Paths follow links. An action lists the check in its `preconditions` like a domain precondition. The core
   evaluates checks over the objects view (`apps/ontology-server/src/checks.ts`), and the shadow replay of a proposal
   uses the same evaluator. Adding or changing a check is a **minor** change.
8. **Dead code removed:**
   - the console decision path of proposals (`ConfigRepoService.decide`, local merges);
   - the ontology server's own flush timer (the Temporal schedule `lake-flush` stays);
   - a second `MailService`;
   - local copies of helpers in the e2e scripts (they use `scripts/liquid/lib.mjs`).

## Outcome

| | Before | After |
|---|---|---|
| Containers of the extension | 4 | **3** (ontology-db, ontology-server, forgejo) |
| Images built locally | 3 | **2** (control-plane, ontology-server) |
| Languages | TypeScript, Python, Rego | **TypeScript, Rego** |
| Deployment modes | console install, compose overlay | **console install** |
| Databases | onto and forgejo (Postgres) | **onto** (Forgejo on SQLite) |
| Secrets | 14 | **12** |
| Generated code in git | 3,144 lines | **0** (the IR stays) |
| Control-plane loops | 5 timers | **one job runner** with uniform status |
| D3 rule | TypeScript in the core | **ontology data** (`checks`) |

The change removed 2,398 lines and added 1,280 (76 files).

## Deviations and why

- **Overlays stay in their own store.** The plan proposed moving policy overlays into the config repository as the
  only store. That was dropped to keep one GitOps pattern for files people review. Overlays are runtime state that
  playbooks set and undo in seconds, and capture into the repository stays as it is.
- **The v2 wait step of `PurchaseOrderRelease` is still code.** It runs when `release_purchase_order` names the
  due-diligence check. Workflow steps are not declarative yet.
- **The compiler supports a subset of LinkML, not LinkML.** The subset is what the sofa ontology and the editor use.
  Anything else is refused with a clear error rather than half-supported.

## Consequences

- Upgrading an existing install needs *Uninstall* with *delete data* and a fresh install: Forgejo's data moves from
  Postgres to SQLite. This was acceptable for the development stack.
- A Python toolchain is no longer needed anywhere in the extension. The compiler's tests are vitest tests.
- Contributors need to know one deployment path. The runtime test covers the same path that users run.
- Apps take their SDK from the running platform (`GET …/sdk`). An ontology change shows up there without a commit,
  and the app registry's re-check finds apps built on an older SDK.
- A new simple business rule (D3-type) is a reviewed ontology change, not a code release. Rules that need more than
  the condition set still need code in the core.

## Verification

- Unit tests and `node scripts/liquid/check.mjs`: build, typecheck, all unit tests, the compiler's golden test,
  `opa test` and *ontology IR up to date*.
- The complete runtime test `node scripts/liquid/e2e-all.mjs` after a fresh install: M0b–M9, D2 and D3 green. In D3 the
  rule is a declarative check.
