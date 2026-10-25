# ADR-0024: Key Vault emulation with Lowkey Vault

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

On Azure, the MCP gateway reads upstream credentials from **Azure Key Vault** with a managed identity. Locally we want
the same code path, not a `.env` shortcut.

## Decision

- Compose service `keyvault` runs **Lowkey Vault** `nagyesta/lowkey-vault:7.3.127`. It provides the Key Vault REST API
  (including secrets and versions) and a managed-identity token endpoint on port 8080.
- TLS uses a **local CA**:
  - The init container `keyvault-certs` (`infra/keyvault/gen-certs.sh`, alpine + openssl) creates `ca.pem` and a
    PKCS#12 server certificate for `keyvault`, stored in the `keyvault-certs` volume.
  - Consumers trust it via `NODE_EXTRA_CA_CERTS`; there is no `NODE_TLS_REJECT_UNAUTHORIZED=0`.
  - The alias `localhost=keyvault:<port>` makes the default vault answer under `https://keyvault:8443`.
- New package `@cw/secrets` (`@azure/keyvault-secrets` 4.11 + `@azure/identity` 4.14):
  - Locally it uses `ManagedIdentityCredential` against Lowkey's token endpoint (`AZURE_POD_IDENTITY_AUTHORITY_HOST`).
  - On Azure it uses `DefaultAzureCredential`.
  - `disableChallengeResourceVerification` is set only when `KEYVAULT_EMULATOR=true`.
- The admin console lists secret **metadata** and sets or rotates values (write-only).
- The demo upstream credential `mcp-demo-authorization` is seeded on first start.

## Consequences

- Only `KEYVAULT_URL` and the identity differ between local and Azure.
- Lowkey Vault is the one Java component in the stack. It was chosen for API fidelity over a TypeScript mock.
- Emulator data is in memory, so secrets are lost on restart. Only the demo secret is re-seeded automatically.
