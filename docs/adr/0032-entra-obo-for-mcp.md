# ADR-0032: Optional Microsoft Entra On-Behalf-Of for MCP calls

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

MCP servers behind the gateway see only a static credential, so they cannot tell which agent acts or for whom.
Microsoft Foundry's identity model expects a token that carries the **agent's** identity and the **user's** identity,
obtained through the Entra On-Behalf-Of (OBO) flow. The capability must be optional: the local stack (local OAuth
server, static upstream headers) has to keep working unchanged.

## Decision

- **The agent is the confidential client.** Each agent can have an Entra application (agent identity) with a client
  secret, certificate or federated credential. It is configured per agent in the admin console (*Identity* tab) and stored
  in the agent spec (`entra`); the credential itself stays in Key Vault.
- **Agents never access Key Vault.** The control plane resolves the credential and passes it to the container as
  environment (`ENTRA_CLIENT_SECRET` / `ENTRA_CLIENT_CERT_PEM`). Deployment fails if the secret cannot be read.
- **User assertion:** the agent signs users in as its Entra application (scope `api://<client>/access_as_user` and
  `offline_access`) and keeps the tokens in a server-side, encrypted store. They are never put into cookies, Temporal
  history or workflow input.
- **Exchange in the agent, delivery per call by the gateway.** For an upstream with `auth: obo` the gateway asks the agent
  (`POST /internal/obo-token`, own bearer, `no-store`) for a token for the upstream's `oboScope`, uses it for that single
  call on a connection that is not shared or cached, and discards it. The harness configuration stays static.
- **Non-interactive tasks** (schedules, agent-to-agent; no signed-in user) can use an **agent-only client-credentials
  token**, only if the upstream says `oboFallback: agent-only` **and** the agent allows it. Default is deny.
- **Fail closed**, in one pure function (`decideUpstreamAuth`): an OBO upstream never falls back to static headers; a task
  with a user is never downgraded to agent-only; a missing, expired or revoked sign-in denies the call.
- **Audit:** tool-call entries record `authMode` and the user's `oid`, never a token.
- **No new dependency:** the token endpoint is called directly (`fetch`, `jose` for certificate assertions), which makes
  the exchange testable against a fake endpoint.

## Azure

The agent's Entra application is the Foundry agent identity; with a managed-identity federated credential no secret exists
at all. APIM, which replaces the gateway ([ADR-0021](0021-mcp-gateway.md)), validates the same token (`validate-jwt` on
`azp` and `oid`). Details: [entra-obo.md](../entra-obo.md).

## Consequences

- OBO needs Entra ID as the sign-in provider; the local OAuth server cannot issue OBO tokens.
- The agent holds refresh tokens of its users. They are encrypted at rest and removed on sign-out or revocation; a long-lived
  task needs a valid grant at the time of each OBO call.
- Tool discovery for OBO upstreams needs an agent-only token, otherwise the last known list is used.
- Without the capability (no `ENTRA_TENANT_ID`, no agent identity, no OBO upstream) there is no behavioural change.
