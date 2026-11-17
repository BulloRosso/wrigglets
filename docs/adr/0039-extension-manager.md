# ADR-0039: Extension manager: optional modules installed from the admin console

- **Status:** Accepted; superseded in part by [ADR-0053](0053-liquid-simplification-ii.md) (overlay mode removed)
- **Date:** 2026-11-16
- **Extends:** [ADR-0003](0003-agent-runtime-abstraction.md), [ADR-0037](0037-optional-signals.md), [ADR-0038](0038-liquid-enterprise-extension.md)

## Context

Signals (ADR-0037) is optional at deploy time only: an administrator restarts the stack with
`docker-compose.signals.yml` and sets environment variables, the console merely hides or shows the module, and switching
it off leaves its gateway upstream behind. Liquid Enterprise (ADR-0038) is much larger (a database, object storage, a
catalog, a compiler, an ontology server, OPA, a worker). People should be able to try it with one click and remove it
cleanly.

The control plane already holds the Docker socket and manages agent containers with dockerode (`DockerRuntime`).

## Decision

1. **Extensions are declared as data.** `packages/extensions` defines a zod `ExtensionManifest`: services (image,
   environment template, volumes, port, healthcheck, dependencies, user, memory), generated secrets, bootstrap steps,
   gateway upstreams the extension owns, and admin console pages. Pure functions compute the dependency order, render
   environments (`{{secret:NAME}}`, `{{svc:NAME.url|host|port}}`; an unknown reference fails instead of starting with an
   empty value), the install/uninstall steps and a service fingerprint.
2. **The control plane installs them** (`apps/admin-server/src/extensions/`):
   - `DockerExtensionRuntime` creates containers `cw-ext-<extension>-<service>` with labels `cw.role=extension`,
     `cw.extension`, `cw.service`, `cw.spec` (fingerprint) on the platform network, with the service name as network
     alias, no host ports. Volumes are labelled `cw.role=extension-data`. It refuses to remove a container whose name
     matches but whose label does not. Compose's `--remove-orphans` does not touch these containers (no compose labels).
   - `ExtensionService` is a persisted state machine (`DATA_DIR/admin/extensions.json`): `not_installed → installing →
     installed | failed → uninstalling → not_installed`, with per-step state. Install: preflight (Docker reachable,
     images present, third-party images pulled, upstream names not taken by someone else) → secrets → volumes → one step
     per service in dependency order (create or re-create when the fingerprint changed, start when stopped, wait until
     healthy) → bootstrap steps (demo-only steps only with "seed demo data") → upstreams. Uninstall: owned upstreams →
     services in reverse order → leftover labelled containers → (purge) volumes and secrets.
   - Every step is idempotent. A failed install is retried from the failed step; an operation interrupted by a restart
     resumes when the control plane starts. "Repair" re-runs all install steps.
   - **Secrets** are generated per extension and stored in `DATA_DIR/admin/extensions-secrets.json` (mode 0600, the same
     protection level as agent secrets in `agents.json`), never in the state file or logs. The credential an upstream
     needs goes to Key Vault as `ext-<extension>-<secret>` and is referenced by `secretRef`; without Key Vault the
     upstream header holds the value, as for manually registered upstreams.
3. **Availability is decided at runtime**, not from environment variables read at startup: installed and every service
   running (cached 10 s), or the compose overlay is active (`LIQUID_OVERLAY=true`). Extension routes use
   `requireExtension` (404 when off); the console shows the extension's pages under their own nav group only while it is
   available.
4. **The overlay stays** for development and CI (`docker-compose.liquid.yml`, `node scripts/stack.mjs liquid
   up|down|reset`). Every manifest service is declared in the overlay under the same name and image (a test checks
   this), so host names are identical in both modes. In overlay mode the console shows the extension read-only and
   refuses install/uninstall; `stack.mjs liquid up` refuses to start while a console install exists.
5. **API** (Platform.Admin, audited): `GET /api/extensions`, `GET /api/extensions/:id`, `POST …/install {seedDemo}`,
   `POST …/repair`, `POST …/uninstall {purgeData}`, `GET …/services/:service/logs`. **UI:** an Extensions page (always in
   the nav) with status, step progress, services, logs, and the actions; Signals is listed read-only.
6. `stack.mjs reset` also removes `cw.role=extension*` containers and volumes; `build --liquid` builds the extension's
   local images once there are any (from M2).

## Consequences

- No new service gets the Docker socket; the control plane's existing access is used for one more purpose. Installing
  an extension is a Platform.Admin action and audited like agent deployment.
- Signals keeps its overlay. Moving it onto the extension manager is possible later (its hub would become a manifest
  service) but is not part of this work.
- The Azure runtime has no extension support; there the console reports "extensions need the Docker runtime".
- Liquid's first manifest (M0b) contains only `ontology-db` (Postgres 17.6, the same tag as `litellm-db`). Digest
  pinning of all liquid images is done with the M1 spike (ADR-0040).
