# ADR-0044: Policy as code with OPA at two enforcement points

- **Status:** Accepted
- **Date:** 2026-11-16
- **Extends:** [ADR-0021](0021-mcp-gateway.md), [ADR-0022](0022-kill-switch.md), [ADR-0043](0043-ontology-server-action-pipeline.md)

## Context

Plan M4: authorization rules that are portable, versioned and testable, enforced at the MCP gateway (coarse) and at the
ontology server (object level), with tightening overlays that playbooks will set later (M7). Fail closed throughout;
tighten automatically, loosen only with a person's decision (invariants 5 and 6).

## Decision

1. **OPA 1.22.0** (`openpolicyagent/opa:1.22.0-static`, pinned by digest) runs as a service of the Liquid extension,
   configured by arguments (the static image has no shell), with `--authentication=token --authorization=basic`. Its
   own authorization policy (`system.authz`) allows only the two decision queries with the query token and the health
   check: nobody can push policies or data through OPA's REST API. Without a bundle the authz policy is missing and OPA
   denies everything.
2. **One bundle from the control plane** (`GET /internal/liquid/opa/bundle.tar.gz`, bearer = bundle token, ETag), built
   deterministically from `policies/liquid/*.rego` (tests excluded; copied into the control-plane image), the roles
   (`policies/liquid/roles/data.json`), the generated ontology data (served by the ontology server), the overlays and
   the query token. OPA polls every 5–10 s, so a policy or overlay change takes effect without restarts. OPA reports its
   decisions (decision logs) back to the control plane; the console keeps the last 200 for the Policies page.
3. **Gateway enforcement point:** a new optional `policy: 'none' | 'opa'` per upstream (default `none` = unchanged
   behaviour). For `opa`, after the existing allow-list, kill-switch and limit checks, the gateway asks
   `liquid.gateway.decision` with agent, user, tool, upstream, action, task (id, step, interactive) and kill-switch
   level. Fail closed: no OPA configuration, timeout (2 s), error, wrong status or no decision deny. The audit entry
   records `policy`, `policyReason`, `obligations`. The control plane adds the OPA address and a Key Vault reference to
   the query token to the gateway config while Liquid is installed. The gateway also passes the task step (`_step`) to
   upstream tools that declare it.
4. **Rules (initial):** least privilege per **role** (`roles.json`, independent of the allow-lists: widening an
   allow-list does not widen a role); read-only in plan steps (second line behind the gateway's own rule); destructive
   actions only in an approved plan (step `run`/`fix`); overlays deny or add obligations; `deny` wins.
5. **Object-level enforcement point:** the ontology server asks `liquid.object.decision` with the action, the caller
   (agent, user, task id and step) and the objects the call touches (class-typed inputs, with criticality, data class
   and owner from the ontology and status from the state). Obligations: `require_four_eyes` — an agent write on a
   payment-critical object **outside an approved task** (the person who approved the plan is the second pair of eyes)
   is not executed; an `ActionApprovalRequested` event is recorded (executed after approval by M5's approval workflow);
   `require_step_up` — denied in the prototype; `deny`. Fail closed like the gateway.
6. **Overlays** (`DATA_DIR/admin/liquid-overlays.json`, moved to the config repository in M6): `{ effect: deny |
   require_four_eyes | require_step_up, reason, match: { actions?, classes?, upstreams?, agents? }, expires_at?,
   source }`. Adding is tightening (admins now, playbooks in M7); removing is loosening and only possible through the
   Platform.Admin API, audited. An overlay must match something.
7. **Tests:** `opa test` (27 cases incl. the generated ontology test) runs in `scripts/liquid/check.mjs` in the pinned
   image; TypeScript tests with fake OPA for both enforcement points (fail closed in every variant, obligations).

## Consequences

- The gateway enforces denials; obligations are recorded there and enforced at the object level, which evaluates the
  same overlays. Upstreams with `policy: opa` are therefore expected to be ontology-backed.
- The sofa scenarios keep working with `policy: opa` on erp/crm: roles reproduce the allow-lists, writes happen in
  approved tasks, destructive actions only after approval (as before by the plan-step rule).
- OPA and the ontology server must be reachable for any call to an `opa` upstream; that is the intended fail-closed
  behaviour.
