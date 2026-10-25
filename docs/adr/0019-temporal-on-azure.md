# ADR-0019: Temporal on Azure — Container Apps + PostgreSQL Flexible Server

- **Status:** Proposed (to be confirmed in milestone M6)
- **Date:** 2026-10-25
- **Spec:** §14.3, §14.4, §21 open question 2

## Decision (proposal)

- **Temporal server** `temporalio/server:<pinned>` as an **Azure Container App** in an *internal*, VNet-integrated
  Container Apps environment (workload profile), all services in one replica (v1), **TCP ingress 7233** (internal),
  mTLS for the frontend (server cert + client CA from Key Vault), config via mounted secret volume.
- **Schema job:** Container Apps *Job* with `temporalio/admin-tools:<pinned>` running `temporal-sql-tool`
  (create/update `temporal` and `temporal_visibility`), triggered manually before each upgrade.
- **Persistence:** Azure Database for PostgreSQL **Flexible Server** (Burstable B2s to start, private access in a
  delegated subnet, TLS, Entra/password auth via Key Vault). `numHistoryShards` chosen once (512).
- **Temporal Web UI** `temporalio/ui:<pinned>` as a second Container App with internal HTTP ingress and Container
  Apps authentication (Entra, admin group); codec endpoint → admin console (ADR-0008).
- **Admin console** (`coworking/control-plane` with `TEMPORAL_MODE=external`) as a third Container App (or App
  Service) — the local "everything in the temporal container" bundling (ADR-0002) is *not* carried over.
- Do **not** use the dev server or `auto-setup` in production.

## Alternatives

- AKS + official Helm chart — choose if the organisation already runs AKS.
- Temporal Cloud — excluded by the spec (§1.2).
