# ADR-0006: Node.js 24 LTS and TypeScript 6

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §3 ("Node.js 22 LTS")

## Context

The spec (written for v1.0 in 2026) names Node.js 22 LTS. In October 2026 Node.js 24 is the *Active* LTS line and
22 is in maintenance. All dependencies (Temporal TS SDK 1.24, node-oidc-provider 9, Vite 8, Vitest 5) support 24.
TypeScript 7 (native compiler) was released in 2026; the ecosystem's type packages are tested against 6.x.

## Decision

- Runtime **Node.js 24** (`node:24.22.1-bookworm-slim`), `engines.node >= 22.12` so 22 still works.
- **TypeScript 6.0.3** (JS compiler), ES modules everywhere (`"type": "module"`, `NodeNext` resolution for servers,
  `Bundler` for web apps).

## Consequences

- Longer support window for the images that go to Azure.
- Upgrading to TypeScript 7 later is a toolchain change only.
