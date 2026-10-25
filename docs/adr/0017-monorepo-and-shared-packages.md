# ADR-0017: pnpm monorepo with shared UI and auth packages

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §3 (repository layout)

## Decision

The spec's layout (`apps/web`, `apps/server`, `packages/workflows|shared|harness-config`) is extended for the platform:

| Spec | Implementation | Purpose |
|---|---|---|
| `apps/server` | `apps/agent-server` | API/BFF + Temporal worker + harness supervisor |
| `apps/web` | `apps/agent-web` | agent UI |
| – | `apps/admin-server`, `apps/admin-web` | control plane (in the temporal container) |
| – | `apps/oauth-server`, `apps/oauth-web` | OpenID Connect server and sign-in pages |
| `apps/server/test/mock-llm` | `apps/mock-llm` | own image for compose |
| `packages/workflows`, `shared`, `harness-config` | unchanged | |
| – | `packages/codec` | payload codec + codec server handler |
| – | `packages/auth-rp` | OIDC relying party (agent + admin) |
| – | `packages/ui` | MUI theme and components (consumed as source by Vite) |
| `deploy/Dockerfile`, `startup.sh` | `infra/docker/Dockerfile` (multi-target), `infra/docker/agent/*.sh` | |
| `infra/bicep` | `infra/azure/` (resource plan; Bicep is a later milestone) | |

Build: `pnpm -r build` (topological). Docker: one build stage, `pnpm deploy --legacy --prod` per server.
Workflow code is bundled at build time (`apps/agent-server/scripts/bundle-workflows.mjs` → `dist/workflow-bundle.js`).
