# ADR-0009: Stateless encrypted sessions and split-horizon OIDC URLs

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Agents and the admin console need a browser session after OIDC sign-in. Browsers reach the OAuth server at
`http://localhost:9000`, containers at `http://oauth:9000`; the ID token's `iss` is always the public URL.
All UIs run on `localhost` with different ports — and **cookies are not isolated by port**.

## Decision

- Session = **JWE cookie** (`dir` + `A256GCM`, key derived from `SESSION_SECRET`) holding the principal
  `{upn, name, oid, roles}`; HttpOnly, SameSite=Lax, Secure when the public URL is HTTPS; TTL 8 h. No server-side
  session store (works with any number of instances, survives restarts).
- **Cookie names are unique per application**: `cw_<agentId>` per agent, `cw_admin` for the console; the OIDC flow
  state (state, nonce, PKCE verifier) lives in a short-lived `<name>_flow` cookie.
- **Split horizon:** discovery, token and JWKS requests go to `OIDC_INTERNAL_URL`; the authorization and end-session
  endpoints are used with their public URLs; `iss` is validated against the public issuer.
- Implemented once in `packages/auth-rp` (used by agent-server and admin-server).

## Consequences

- Sign-out clears the cookie and calls RP-initiated logout at the OP.
- Revoking access takes effect at session expiry or next sign-in (acceptable; disabling a user also ends the OP session).
- On Azure with EasyAuth the cookie handling is done by App Service and `AUTH_MODE=easyauth` is used instead.
