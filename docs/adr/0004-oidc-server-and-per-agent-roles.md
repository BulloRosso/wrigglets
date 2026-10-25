# ADR-0004: Own OpenID Connect server with per-agent roles; Entra ID compatible

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §2.2 #4 (identity server-side only), §9.1, §13 (EasyAuth / Entra ID, app roles)

## Context

Locally there is no Entra ID and no App Service EasyAuth. The requirement: *"an OAuth server container which the admin
UI can administer — when someone wants to authenticate with an agent container this is the authentication instance."*
TypeScript/Node.js should be used where possible.

## Decision

- **OAuth server** = `apps/oauth-server`, built on the certified library **node-oidc-provider 9** (authorization code
  flow, PKCE required, confidential clients, RP-initiated logout). Sign-in pages are a small React/MUI app
  (`apps/oauth-web`). Consent is granted automatically (all clients are first-party).
- **Users and clients** are stored by the OAuth server (JSON file on its volume locally). A bearer-token protected
  **management API** (`/admin/api/*`) is used by the admin console only (server-to-server).
- **Per-agent authorization:** every agent is its own OIDC client `agent-<id>` (client metadata `cw_kind=agent`,
  `cw_agent_id=<id>`). A user has `platformRoles` and `agentRoles: { "<agentId>" | "*": [roles] }`. The ID token's
  `roles` claim is computed **for the requesting client**: the roles for that agent (plus `*`), or all agent roles for
  `Platform.Admin`. Users without `Agent.User` for an agent are refused at the sign-in page.
- Role names are those of the spec's Entra app roles: `Agent.User`, `Agent.Approver`, `Agent.Admin`
  (plus `Platform.Admin` for the console).
- The agent server keeps the spec's three identity modes: `oidc` (default locally), `easyauth` (spec §9.1, App
  Service) and `dev`. The OIDC relying party (`packages/auth-rp`) is standard OIDC, so it also works with **Entra ID**
  (`roles` claim from app roles, `oid`, `preferred_username`).

## Consequences

- The agent never trusts identity from the browser; it validates the ID token (issuer, audience, nonce, signature)
  and keeps the principal in an encrypted cookie (ADR-0009). Updates/decisions carry the server-side principal.
- Role changes take effect at the next sign-in (session TTL 8 h); disabling a user revokes OP sessions immediately.
- **Azure options:** (a) recommended — use **Entra ID**: one app registration per agent (or one shared app with
  per-agent app roles), EasyAuth or `AUTH_MODE=oidc` against Entra; the admin console then manages role assignments
  through Microsoft Graph instead of the management API; (b) keep this OAuth server as a Container App with a database
  (PostgreSQL) instead of the JSON file and in-memory session store, behind Front Door/App Gateway with TLS.
- The in-memory session store means an OAuth server restart signs users out *of the OP* (not of agents).

## Alternatives considered

- *Keycloak*: feature-rich but Java, heavy, and not "TypeScript where possible".
- *Dex / Authelia*: not administrable through an API in the needed way (Dex static config).
