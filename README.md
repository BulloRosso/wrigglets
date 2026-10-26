<p align="center"><img src="docs/images/wrigglets-banner.png" alt="Wrigglets! Five cartoon caterpillar agents playing on a playground" width="720"></p>

# Coworking Agents

AI colleagues that teams talk to through a web UI. Each agent works on one shared, Git-versioned workspace;
**Temporal** frames all work so that it is always reconstructable who requested what, who approved it, what was done
and what is scheduled. The **Agent Harness** (opencode) does the work with the model of the AI gateway.

This repository implements [`agent-implementation-spec.md`](agent-implementation-spec.md) for a **local Docker
Desktop** environment, extended to a small platform:

- **`temporal` container** — Temporal server (dev server) + Temporal Web UI + **admin console** to spin up, configure
  and monitor agent containers and to manage users and access
- **`oauth` container** — OpenID Connect server (node-oidc-provider) that agents use for sign-in, administered by the
  admin console (per-agent roles)
- **agent containers** — API + Temporal worker + Agent Harness, created on demand
- **`mcp-gateway` container**: the only MCP endpoint agents see; it holds the per-agent tool allow-lists and the
  kill switch, and brokers **agent-to-agent (A2A)** delegation inside each agent's discovery set
- **`mcp-web` container**: **internet access** for agents (web search, reading public pages) as gateway tools,
  allowed per agent; private and internal addresses are refused
- **`keyvault` container**: Azure Key Vault emulator (Lowkey Vault) for upstream credentials
- **Kill switch**: per agent and global, with graded levels (tools off, paused, stopped) and automatic triggers
- **Real AI model via LiteLLM 1.102.0 → OpenAI**: `OPENAI_API_KEY` from your environment, a virtual key per agent,
  a **spend limit in USD per 30 days** instead of token budgets, and current token prices. If no model is available,
  the UIs say what to configure.
- **Human in the loop by e-mail**: when a task needs a decision, the agent mails everybody with access to it, with
  links straight into the decision dialog. Mails go to a configurable mail API or the outbox (`mail_out`), and admins
  can review them in the console.
- **Task conversation and chat**: a Markdown history per task (request, agent reports, decisions, results), and you
  can **ask the agent** about the task, its files and images; it answers with its model
- **File preview** in the agent UI: Markdown, Mermaid diagrams, PDF, text, CSV, images, Excel
- **Agent portraits** in four moods, generated from a guiding image with an OpenAI image model
- TypeScript/Node.js throughout, React + Material UI with one shared theme, prepared for Azure (private ACR, APIM, Key Vault)

## Architecture

**a) Technical components:** the containers of the local stack, their ports and connections.

<img src="docs/diagrams/00a-technical-components.svg" alt="Technical components of the local stack: containers, ports and connections" width="100%">

**b) Responsibilities:** who does what in the application, along the life of a task.

<img src="docs/diagrams/00b-responsibilities.svg" alt="Responsibilities in the application, grouped by concern" width="100%">

More detail: [docs/architecture.md](docs/architecture.md); safety, gateway and A2A in
[diagram 10](docs/diagrams/10-killswitch-gateway.svg).

## Microsoft Entra On-Behalf-Of (optional)

MCP servers can receive a **Microsoft Entra token that carries two identities**: the **agent** (`azp`) and the **user** it
works for (`oid`, `upn`). This is the identity model of Microsoft Foundry, obtained through the Entra *On-Behalf-Of* flow.
It is off by default; the local stack keeps working with static upstream credentials.

- Each agent can have its own **Entra identity** (app registration with a secret, certificate or federated credential),
  set in the admin console on the agent's **Identity** tab. The agent signs users in and keeps their tokens encrypted.
- An upstream MCP server is switched to **Entra On-Behalf-Of** in the gateway settings. For every tool call the gateway gets a
  short-lived token from the agent and uses it for that call only; user tokens never leave the agent.
- **Fail closed**: no valid user sign-in means no call, and an OBO upstream never falls back to static credentials.
  Scheduled and agent-to-agent tasks have no user; they are denied, or, if explicitly allowed per upstream and agent,
  use the agent's own token without a user identity.
- Agents have **no access to Key Vault**; the control plane hands them their credential.

Needs a real Entra tenant (`ENTRA_TENANT_ID`). Model, set-up, rules and operations: **[docs/entra-obo.md](docs/entra-obo.md)**
([ADR-0032](docs/adr/0032-entra-obo-for-mcp.md)).

## Security: exfiltration guard

Background agents read untrusted text, so a **multi-turn prompt injection** can plant a goal early and let a later call
of an allowed tool (for example an e-mail tool) carry data out. The guard checks every tool call before it runs:

1. **Pre-tool hook:** an opencode plugin (`tool.execute.before`) sends every tool call of the Agent Harness to the
   agent server, which asks an **evaluation agent**. If that cannot be reached, the call is refused.
2. **Evaluation agent:** a nano-class model (default `gpt-5.4-nano`, on the agent's own LiteLLM key). It sees the **last
   5 model round-trips** of the task conversation (prompts, tool calls, tool results) and the pending call, and
   answers `allow` or `block` with a category and a reason.
3. **On a block:** the tool never runs, the user's task is **cancelled**, the harness is aborted, and a **warning goes
   to Temporal** (the agent's `AgentWorkflow`). It stops the agent at once and delivers a **security alert** to the
   control plane, which stops all tasks of the agent (kill switch) and shows the alert on the **admin dashboard**.
4. **Tailored, editable policy:** the system prompt of the evaluation agent targets multi-turn injection and data
   extraction and is edited in the admin console under *Safety & tools → Exfiltration guard*, together with model,
   context size, halt level and fail mode.

The guard is one layer next to tool allow-lists, the MCP gateway and the kill switch; it is probabilistic and does not
cover what happens with the agent's output afterwards.

Details, sequence diagram, configuration and limits: **[docs/exfiltration-guard.md](docs/exfiltration-guard.md)**
([ADR-0033](docs/adr/0033-exfiltration-guard.md)). A runnable attack suite with a mock MCP server:
[docs/red-teaming.md](docs/red-teaming.md).

## Quick start

```bash
node scripts/stack.mjs up
```

Then open http://localhost:8080, sign in with the printed admin credentials and create an agent.
Details: [docs/getting-started.md](docs/getting-started.md). New here? Follow the **[guided tour](guided-tour.md)**.

## LiteLLM version (supply chain)

> [!IMPORTANT]
> LiteLLM was recently the target of a supply-chain attack. This repository therefore uses **exactly LiteLLM 1.102.0**,
> pinned by image digest in [`docker-compose.yml`](docker-compose.yml):
>
> ```text
> litellm/litellm:v1.102.0@sha256:32cfd7a427f6470033b4dcc9e75dfbea2aa32dbc298b0b511a40e962ce818362
> ```
>
> - Docker refuses to start a different image under this name, because the digest must match.
> - The image is identical to `ghcr.io/berriai/litellm:v1.102.0`; the linux/amd64 manifest digest is
>   `sha256:9d60771c86a42ced1b918f23dd940a1ac9905ddb02a4fae779cfe1937477c9a0` in both registries.
> - The image is not built here and no LiteLLM Python package is installed anywhere else in the stack.
> - LiteLLM only sees the OpenAI key and the agents' virtual keys; agents never see the OpenAI key.
> - **Before upgrading:** check the LiteLLM security advisories, compare the digest published by the maintainers, and
>   change the tag *and* digest together.
>
> Verify the running image: `docker inspect cw-litellm --format '{{.Image}}'` and
> `docker run --rm --entrypoint python litellm/litellm:v1.102.0 -c "import importlib.metadata as m; print(m.version('litellm'))"`
> (prints `1.102.0`).

## Documentation

- [Guided tour](guided-tour.md): set up an agent and work with it, step by step with screenshots
- [Technical documentation](docs/architecture.md) (architecture, diagrams, APIs, configuration, verification)
- [Exfiltration guard](docs/exfiltration-guard.md): protection against multi-turn prompt injection
- [Azure target and resource types](docs/azure.md)
- [Runbook](docs/runbook.md)
- [Architecture Decision Records](docs/adr/README.md)

## Repository

| Path | |
|---|---|
| `apps/agent-server`, `apps/agent-web` | the agent (API/BFF, worker, harness supervisor; UI) |
| `apps/admin-server`, `apps/admin-web` | control plane and admin console (runs in the temporal container) |
| `apps/oauth-server`, `apps/oauth-web` | OpenID Connect server and sign-in pages |
| `apps/mcp-gateway`, `apps/mcp-demo`, `apps/mcp-web` | MCP gateway (tools, kill switch, A2A broker), example upstream and internet access (search, fetch) |
| `packages/secrets` | Key Vault access (`@azure/keyvault-secrets`), works against the emulator and Azure |
| `packages/*` | shared DTOs, workflows, codec, harness config, OIDC RP, MUI theme/components |
| `infra/docker` | multi-target Dockerfile and agent entrypoint |
| `infra/keyvault` | local CA and TLS certificate for the Key Vault emulator |
| `assets` | default guiding image for agent portraits |
| `infra/temporal` | namespace bootstrap script for self-hosted Temporal (Azure) |
| `docker-compose.yml`, `scripts/stack.mjs` | local stack |

## Tests

```bash
corepack pnpm install && corepack pnpm -r build && corepack pnpm test
```

88 tests: workflow behaviour against a local Temporal test server (approvals, lock, cancellation, budget,
continue-as-new, kill-switch suspend/resume, delegation wait), replay of recorded histories, timeline mapping, Git
conventions, path safety, OIDC roles, codec, gateway policy, safety rules, approval mails, LiteLLM spend and status.
