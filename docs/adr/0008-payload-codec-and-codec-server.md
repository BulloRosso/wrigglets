# ADR-0008: Shared payload-codec key ring and codec server in the control plane

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §7.10, §13 (payloads encrypted)

## Decision

- `packages/codec` implements AES-256-GCM. Keys come from `PAYLOAD_CODEC_KEYS="k2:<b64>,k1:<b64>"`; the **first**
  key encrypts, all keys decrypt; the key id is stored in the payload metadata (`encryption-key-id`) for rotation.
- All agents and the control plane share the key ring (one namespace, ADR-0005).
- The **codec server** for the Temporal Web UI (`POST /codec/encode|decode`, remote codec JSON protocol) runs in the
  admin server, because the Web UI runs in the same container and needs exactly one endpoint
  (`--ui-codec-endpoint http://localhost:8080/codec`). Each agent also exposes `/codec/*` (Agent.Admin), as in the spec.
- Search attributes are **not** encrypted (they must be queryable) — never put sensitive content in them; titles are.

## Consequences

- Locally the control-plane codec endpoint is protected by CORS (only the Web UI origin) and a loopback-only port
  binding, not by a user session (the dev-server UI does not forward our cookie). **On Azure** it must sit behind
  Entra authentication (Container Apps auth) together with the Web UI, as the spec requires.
- Key rotation: prepend a new key, redeploy all agents + control plane, keep the old key until all histories that used
  it are past retention (90 days) *and* audit exports were written (they contain decoded history).
