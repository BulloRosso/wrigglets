# ADR-0038: Liquid Enterprise as an optional, installable extension

- **Status:** Accepted
- **Date:** 2026-11-16
- **Extends:** [ADR-0021](0021-mcp-gateway.md), [ADR-0022](0022-kill-switch.md), [ADR-0037](0037-optional-signals.md)
- **Plan:** [liquid-enterprise-extension.md](../liquid-enterprise-extension.md) · **Docs:** [liquid-enterprise.md](../liquid-enterprise.md)

## Context

Wrigglets covers the agent half of an enterprise platform: agents with a harness, durable workflows, the MCP gateway as
the only tool path, kill switch, safety rules, approvals, wikis and Signals. Business data, however, lives behind
ad-hoc MCP upstreams (in the sofa example a mock with in-memory state). Its meaning is implicit in tool descriptions,
rules are scattered over allow-lists and code, and nothing above the upstream is independent of it.

We want a prototype of a "liquid enterprise": an architecture that adapts to new business requirements and new security
risks by itself, within guardrails, without vendor lock-in.

## Decision

1. **Build it as an optional extension** of the existing platform, called *Liquid Enterprise*. It adds a data half (open
   lake + append-only event log), a versioned LinkML ontology compiled into every layer, an ontology server as the only
   write path, policy as code (OPA), holdable business workflows, a config repository with reviewed proposals, playbooks
   with autonomy tiers, an ontology change pipeline, Entra as IdP option and an app registry. The full plan is
   `docs/liquid-enterprise-extension.md` (milestones M0–M10, plus M0b and the editor tracks E1–E4).
2. **Installable from the admin console.** Unlike Signals, which needs a restart with an overlay, an administrator
   installs and uninstalls the extension from a new Extensions page (M0b, ADR-0039). The overlay
   `docker-compose.liquid.yml` remains for development and CI. Without the extension, the stack and its tests behave as
   at commit `79ac9c6`.
3. **Architectural invariants** (plan §1.3) are binding for all later decisions: nothing above the ontology binds to
   physical tables; actions are the only write path; raw data is immutable and the projection is rebuildable; one
   source compiled everywhere; fail closed; tighten automatically, loosen only with approval; desired state in Git
   (from M6); optional and additive.
4. **One user document.** `docs/liquid-enterprise.md` holds activation, architecture, IR contract, editor, policies,
   workflows, proposals, playbooks, runbook, results, and the implementation log as its appendix. ADRs stay in
   `docs/adr/`, numbered in creation order (0038–0049).
5. **A React Flow ontology editor** in the admin console lets people view and change the ontology; changes go through
   draft → validate → proposal → owner approval (ADR-0042).
6. **Out of scope:** n8n (Temporal and ontology actions cover short flows), production Azure deployment, multi-tenant
   Temporal, a real ERP, high availability, GraphQL.

## Consequences

- The repository grows by several packages and apps (`packages/ontology-*`, `apps/ontology-server`, …) and a Python
  compiler image; the root build gains an `ontology:build` step from M2.
- The control plane uses its existing Docker socket to manage extension containers; no new service gets the socket.
- Security defaults (fail closed, kill switch semantics, approval rules) are kept and extended, never relaxed. Changing
  them requires a human decision and its own ADR.
- Every milestone ends with green tests, an ADR, updated docs and an implementation-log entry.
