# ADR-0021: Central MCP gateway (own TypeScript gateway locally, Azure API Management later)

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Agents need governed access to company systems (supplier directory, ERP, SharePoint, …) as MCP tools. If each
agent configured its own MCP servers, credentials would sit in containers and workspaces, every agent would need its
own allow-list, and an incident response would have to touch every agent.

## Decision

- Every agent gets **exactly one** MCP server in its harness config: the gateway endpoint
  `http://mcp-gateway:7400/agents/<agentId>/mcp` (Streamable HTTP, stateless, `@modelcontextprotocol/sdk` 1.32).
  The agent authenticates with its **per-agent internal token**; the gateway only knows the token's SHA-256.
- The gateway aggregates **upstream MCP servers** (`gateway.json`, managed in the admin console) and exposes their
  tools as `<upstream>__<tool>` (opencode shows them as `gateway_<upstream>__<tool>`).
- Each call is checked in this order, and the gateway **fails closed**:
  1. Config freshness: if the config is older than 30 s, everything is denied.
  2. Kill switch: `tools_off` and above deny the call.
  3. Per-agent allow-list (glob patterns).
  4. Limits: 60 calls/min, 64 KB of arguments, 60 s timeout.
- Every call is audited as JSONL: tool, outcome, sizes and duration, but no arguments.
- Upstream credentials are **references to Key Vault secrets** (`{ secretRef }`, ADR-0024). The gateway resolves them
  at call time and caches them for 5 minutes. They never reach the agent, the harness, the workspace or the gateway config.
- The control plane is the source of truth. The gateway polls `GET /internal/gateway-config` every 2 s, and the
  admin console pushes `POST /internal/refresh` after changes.
- The gateway also hosts the built-in **A2A tools** (ADR-0023).
- Locally, an example upstream `apps/mcp-demo` (supplier lookup, FX rates) makes the flow testable end to end.

## Azure

**Azure API Management** replaces the gateway:

- The upstream APIs are exposed as MCP servers.
- One product/subscription per agent gives each agent its own allow-list and kill switch.
- Policies: `rate-limit-by-key` and `validate-content`.
- Named values come from Key Vault; diagnostics go to Application Insights.

The agent-facing contract stays the same: one Streamable HTTP endpoint per agent, with a bearer token. APIM does not
broker A2A, so A2A brokering moves into a small Container App behind APIM.

## Consequences

- Tool access can be cut in one place within seconds, there is one audit stream, and each agent has least privilege.
- The gateway is a single point of failure for tools. This is by design (fail-closed); file work continues without it.
