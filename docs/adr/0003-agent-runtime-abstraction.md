# ADR-0003: Agent runtime abstraction — Docker locally, one App Service per agent on Azure

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §1.1 #6 (one App Service B2, Always On), §1.2 (no scale-out), §14.2

## Context

The spec describes *one* agent on *one* App Service instance. The new requirement is an admin console that can spin up
and monitor *several* agent containers. Locally everything runs on Docker Desktop; later Azure with a private ACR.

## Decision

- The admin server talks to an `AgentRuntime` interface (`apps/admin-server/src/runtime/types.ts`) with the operations
  deploy, start, stop, restart, remove, inspect, stats, logs, images.
- **Local:** `DockerRuntime` uses the Docker Engine API via the socket mounted into the control-plane container
  (`/var/run/docker.sock`, library `dockerode`). Per agent it creates
  - a container `cw-agent-<id>` from `coworking/agent:<tag>` on the network `coworking` (alias `agent-<id>`),
  - a named volume `cw-agent-<id>-home` mounted at `/home` (the persistent workspace, like App Service `/home`),
  - a host port binding `127.0.0.1:<81xx> → 8080` for the agent UI,
  - CPU/memory limits, restart policy `unless-stopped`, a health check on `/health`.
- **Azure:** `AzureAppServiceRuntime` (stub with documented intended calls) creates **one Linux Web App per agent**
  on a shared App Service plan, `linuxFxVersion = DOCKER|<acr>.azurecr.io/coworking/agent:<tag>`, ACR pull with
  managed identity, `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` for `/home`, Always On, VNet integration.
- The **agent image is identical** in both environments; all differences are configuration (environment variables).
- Desired state (spec of each agent + generated secrets) is kept by the control plane (`/data/admin/agents.json`
  locally; Table Storage/Cosmos DB or Key Vault + App Configuration on Azure).

## Consequences

- Mounting the Docker socket gives the control plane root-equivalent power on the Docker host. Acceptable on a
  developer machine; it is bound to `127.0.0.1` and only Platform admins can use the console. Never do this on a shared
  host.
- Re-deploying an agent re-creates its container; the volume (workspace, Git history, audit exports) survives.
  In-flight steps are retried by Temporal; Git checkpoints make that idempotent (spec §8.3).
- Plan sizing on Azure: one B2 per agent (spec) or several agents per plan (density). App Service `/home` is per app,
  so workspaces stay isolated either way. Capacity per plan must be checked (B2 = 2 vCPU/3.5 GB).

## Alternatives considered

- *Docker Compose profiles per agent*: static, not manageable from a UI.
- *Azure Container Apps per agent*: viable (Azure Files for `/home`, scale to 0/1), but the spec fixed App Service
  with Always On, B2 and SMB `/home`; App Service also gives EasyAuth out of the box. Keep as option.
