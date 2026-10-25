# ADR-0020: No registry locally; private ACR on Azure

- **Status:** Accepted
- **Date:** 2026-10-25

## Decision

- **Locally** images are built into the Docker Desktop image store (`coworking/agent:local`,
  `coworking/control-plane:local`, `coworking/oauth:local`, `coworking/mock-llm:local`). The admin console lists local
  tags of `AGENT_IMAGE_REPOSITORY` (`coworking/agent`) as selectable images and only pulls if an image is missing.
  New agent versions = build a new tag (`docker build --target agent -t coworking/agent:<tag> -f infra/docker/Dockerfile .`)
  and select it in the agent's settings ("Save & redeploy").
- **Azure:** a **private Azure Container Registry** (Premium if private endpoints are required, otherwise Basic/Standard),
  admin user disabled, images pushed by CI with the Git SHA as tag (spec §17), pulled by App Service/Container Apps
  with **managed identity** (`AcrPull`). The admin console lists tags via the ACR data-plane API and sets
  `linuxFxVersion` per agent. Image scanning (Trivy in CI and/or Defender for Containers).

## Consequences

- Image references are configuration (`AGENT_IMAGE`, per-agent `image`), so the same code works in both environments.
- Note: ACR **private endpoints require the Premium SKU**; with Basic/Standard the registry is reachable publicly
  (authenticated). Decide together with the network design.
