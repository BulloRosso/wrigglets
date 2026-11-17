# ADR-0050: Entra ID as identity provider option; app registry and app host for generated UIs

- **Status:** Accepted (local parts verified; Entra sign-in waits for a real tenant)
- **Date:** 2026-11-17
- **Extends:** [ADR-0004](0004-oidc-server-and-per-agent-roles.md), [ADR-0032](0032-entra-obo-for-mcp.md), [ADR-0048](0048-ontology-evolution-runtime.md), [ADR-0049](0049-liquid-simplification.md)

## Context

Plan M9 has two goals:
- Entra ID as the target identity provider. The local OAuth server stays the default for local runs.
- A governed path for many small, often generated ("vibe-coded") UIs.

Such apps are written quickly and by many people, so the platform has to be able to answer:
- What does an app talk to?
- What may it change?
- Who owns it?
- When does it stop working?

## Decision

### Identity

1. **`ADMIN_AUTH_MODE=entra`** signs administrators in to the admin console at Entra ID. It needs:
   - `ENTRA_TENANT_ID` (a GUID; the issuer is `https://login.microsoftonline.com/<tenant>/v2.0`);
   - `ADMIN_ENTRA_CLIENT_ID` and `ADMIN_ENTRA_CLIENT_SECRET`.

   The local OAuth server keeps running for agent sign-in and the per-agent role administration. Configuration
   errors stop the start (fail at boot, not at the first sign-in).
2. **Role mapping** (`roleMapper` in `@cw/auth-rp`): Entra puts app-role *values* into `roles` and, optionally,
   group object ids into `groups`.
   - `ENTRA_ROLE_MAP` maps either kind to platform roles, e.g. `Admins=Platform.Admin;<group-id>=Agent.User,Agent.Approver`.
   - Role values without an entry pass through unchanged. App roles named like the platform roles (recommended) need
     no map.
   - The group overage of large tenants (`_claim_names`) cannot be resolved without Graph and is ignored; use app
     roles there.
   - The same mapper is used by agents (`OIDC_ROLE_MAP`).
3. **Agents with an Entra identity sign users in at Entra.** An OBO agent's sign-in client is its Entra application
   (ADR-0032). The control plane now sets its `OIDC_ISSUER` to the tenant's issuer. Until now that only worked if the
   whole platform's `OAUTH_ISSUER` pointed to Entra.
4. **Entra Agent ID (⚠ VERIFY result).** Entra Agent ID has been generally available since spring 2026. It needs an
   Entra ID Governance or Entra Suite license and a tenant, which this prototype does not have. We keep one Entra
   app registration per agent (ADR-0032) as the agent identity. Moving to Agent ID is a later, tenant-specific step:
   it changes the credential, not the OBO flow. Adopting a paid license is the operator's decision.

### Apps

5. **App SDK** (`genAppSdk` in `@cw/ontology-codegen`, `GET /api/liquid/ontology/sdk?kind=app`):
   - one standalone TypeScript file for the ontology in force, with no dependencies;
   - typed objects and actions;
   - relative same-origin calls only;
   - no token: the app host holds the session.
6. **App registry** (`/liquid/apps`, `/api/liquid/apps`): an app is registered with id, name, owner, description, the
   actions it may run, the classes it may read, an optional source link, an expiry (default 180 days, at most 365)
   and its files (source, `package.json`, the SDK, the built `dist/`). The **registration check** is static and
   strict:

   | Check | Rule |
   |---|---|
   | layout | `package.json`, `src/`, `src/liquid-sdk.ts`, `dist/index.html`; safe paths; ≤ 5 MB, ≤ 400 files |
   | dependencies | exact versions only; runtime deps ⊆ {react, react-dom}; dev deps ⊆ {vite, @vitejs/plugin-react, typescript, @types/react(-dom)}; no install scripts |
   | only the SDK | `src/liquid-sdk.ts` byte-identical to the SDK of the ontology in force; no other file uses `fetch`, XHR, WebSocket, EventSource, beacons, workers, `eval`, `new Function`, `document.cookie`, `window.open`, absolute URLs, or imports other packages |
   | actions and classes | exist in the ontology in force |
   | bundle | `dist/index.html` loads nothing from another origin and has no inline script |

   Registration never activates an app. **Activation** re-checks against the ontology in force and creates the
   app's OIDC client in the local OAuth server (`app-<id>`, kind agent). Who may use an app is the role
   `Agent.User` on that client, granted per person on the app's card. Administrators and users with `Agent.User` on
   all agents inherit it. The OAuth server itself refuses anyone without the role. **Expiry** (hourly job),
   **Disable** and a new version remove the client; the access list stays with the app. Every state change is an
   event (object type `App`) and audited.
7. **App host**: a second listener of the control plane (`APPS_PORT` 8090, `APPS_PUBLIC_URL`), so apps get **an
   origin of their own** and never share the console's. It serves `/apps/<id>/`:
   - the built files, under a strict CSP (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`);
   - the app's own sign-in, with cookies scoped to the app's path;
   - `/apps/<id>/api/*`, which forwards only the app's registered actions and reads to the enterprise core with its
     internal token. The caller is set by the host (`_requestedBy` = the person, `_app` = the app); every `_`-field
     from the browser is dropped, so an app cannot claim an approval.

   API calls must carry the SDK's header and a Referer below the app's own path, so one app cannot use another app's
   session on the same origin. An app that is not active answers 410.
8. **Sample app** `apps/liquid-app-due-diligence` ("Supplier due diligence"): React on the app SDK only. It needs
   the ontology change "DueDiligenceStatement + submit_due_diligence_statement", which goes through a reviewed pull
   request like any change (M8). The action runs generically, without domain code. `scripts/liquid/app-register.mjs`
   downloads the SDK, builds and registers, the way a person would.

## Consequences

- Apps cannot be rebuilt by the platform: the registry stores what was submitted. A new ontology version that changes
  the SDK makes *Check again* fail. The owner downloads the new SDK, rebuilds and registers a new version, and the app
  stays usable until then because the host keeps forwarding its registered actions. Actions that were removed
  fail in the core.
- App sign-in uses the local OAuth server also when the console uses Entra. With Entra, an app needs an Entra app
  registration of its own; that is not automated in the prototype (open).
- The app host is part of the control plane process: one more port, no extra container.
- The static check is a strong signal, not a sandbox. The CSP and the host's forwarding rules are what enforce it at
  runtime.
