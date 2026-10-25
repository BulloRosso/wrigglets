# ADR-0002: Temporal and the admin console share the "temporal" container locally

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §1.2 (no forks), §14.3 (Temporal on Azure), §15 (local development)

## Context

The local environment must run on Docker Desktop only. The requirement is: *"an admin UI in the temporal container
where I can spin up and monitor agent containers"*. The spec's local setup already uses the Temporal CLI dev server
(`temporal server start-dev`, SQLite). Production on Azure uses the real Temporal server on Container Apps with
PostgreSQL.

## Decision

Build one image `coworking/control-plane` that contains

1. the **unmodified** Temporal CLI binary (copied from the pinned image `temporalio/temporal:1.9.1`), started as a
   supervised child process: `temporal server start-dev` with a SQLite file on the `/data` volume, the Temporal Web UI
   on `:8233`, the namespace and all custom search attributes registered at start, and the codec endpoint of the admin
   console configured for the Web UI;
2. the **admin server** (Node.js/TypeScript) that supervises the Temporal process (restart with back-off),
   bootstraps the namespace idempotently (retention 90 days, search attributes via the operator API) and serves the
   admin console (`:8080`).

The compose service is called `temporal`, so agents reach the frontend at `temporal:7233`.

## Consequences

- One container gives the "Temporal + admin" experience requested; the Temporal Web UI stays available for operators.
- The dev server is **not** production-grade (single process, SQLite). That is acceptable locally and matches spec §15.
- On Azure the two concerns are separated again (ADR-0019): Temporal server as its own Container App, the admin console
  as another Container App (or App Service). The admin server already supports `TEMPORAL_MODE=external` for that.
- The process supervisor pattern is the same as for the Agent Harness in the agent container (spec §5.4).

## Alternatives considered

- *`temporalio/auto-setup` + PostgreSQL container locally*: closer to Azure, but heavier, deprecated upstream and not
  "in one container" with the admin UI.
- *Admin UI as separate container*: cleaner separation, but does not meet the stated requirement.
