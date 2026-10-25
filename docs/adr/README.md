# Architecture Decision Records

We record every significant or non-obvious decision as an ADR (format: [ADR-0001](0001-record-architecture-decisions.md)).
The implementation specification (`agent-implementation-spec.md`) requires ambiguities and deviations to be recorded here.

| # | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-temporal-in-control-plane-container.md) | Temporal and the admin console share the "temporal" container locally | Accepted |
| [0003](0003-agent-runtime-abstraction.md) | Agent runtime abstraction: Docker locally, one App Service per agent on Azure | Accepted |
| [0004](0004-oidc-server-and-per-agent-roles.md) | Own OpenID Connect server with per-agent roles; Entra ID compatible | Accepted |
| [0005](0005-multi-agent-namespacing.md) | Multiple agents: per-agent task queue, ids and schedules | Accepted |
| [0006](0006-node-24-typescript-6.md) | Node.js 24 LTS and TypeScript 6 | Accepted |
| [0007](0007-harness-configuration.md) | Agent Harness configuration and hardening (opencode 1.19) | Accepted |
| [0008](0008-payload-codec-and-codec-server.md) | Shared payload-codec key ring and codec server in the control plane | Accepted |
| [0009](0009-sessions-and-split-horizon-oidc.md) | Stateless encrypted sessions and split-horizon OIDC URLs | Accepted |
| [0010](0010-schedule-history-in-audit-log.md) | Schedule change history in the application audit log | Accepted |
| [0011](0011-material-ui.md) | Material UI (MUI) for all user interfaces | Accepted |
| [0012](0012-task-ids-and-file-safe-paths.md) | Task ids of scheduled runs and file-system-safe paths | Accepted |
| [0013](0013-mock-llm.md) | Scripted OpenAI-compatible mock model for development and tests | Accepted |
| [0014](0014-approval-rules-in-workflow.md) | Approval rules enforced by update validators (and the API) | Accepted |
| [0015](0015-deviation-rejection-reverts.md) | Rejecting a deviation reverts the task's run/fix commits | Accepted |
| [0016](0016-verification-path-policy.md) | Verification: path policy per task type and plug-in scripts | Accepted |
| [0017](0017-monorepo-and-shared-packages.md) | pnpm monorepo with shared UI and auth packages | Accepted |
| [0018](0018-cancellation-semantics.md) | Cancellation semantics and lock safety | Accepted |
| [0019](0019-temporal-on-azure.md) | Temporal on Azure: Container Apps + PostgreSQL Flexible Server | Proposed |
| [0020](0020-container-registry.md) | No registry locally; private ACR on Azure | Accepted |
| [0021](0021-mcp-gateway.md) | Central MCP gateway (own TS gateway locally, Azure API Management later) | Accepted |
| [0022](0022-kill-switch.md) | Kill switch: graded levels, enforcement points, automatic triggers | Accepted |
| [0023](0023-a2a-between-agents.md) | Agent-to-agent delegation (A2A): discovery sets, gateway-mediated | Accepted |
| [0024](0024-key-vault-emulation.md) | Key Vault emulation with Lowkey Vault | Accepted |
| [0025](0025-agent-portraits.md) | Agent portraits generated with an OpenAI image model | Accepted |
