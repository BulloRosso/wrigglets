# ADR-0029: LiteLLM as AI gateway, virtual keys per agent, USD spend limits

- **Status:** Accepted
- **Date:** 2026-10-25
- **Supersedes:** [ADR-0013](0013-mock-llm.md) (scripted mock model)

## Context

A scripted mock model is not useful for evaluating AI colleagues: plans, reports and tool use only make sense with a
real model. Token limits per task are hard for users to reason about. What matters is money, per agent and over
time.

## Decision

- **Gateway:** **LiteLLM 1.102.0**, exactly this version, as compose service `litellm`. The image is
  `litellm/litellm:v1.102.0`, pinned by digest. It is the same image as `ghcr.io/berriai/litellm:v1.102.0`; the
  amd64 digests are identical. Docker Hub is used because ghcr.io pulls fail with stale local registry credentials.
  LiteLLM uses PostgreSQL 17 (`litellm-db`) for keys and spend logs.
- **Upstream:** the OpenAI API with `OPENAI_API_KEY` from the machine's environment. The key is passed through
  compose and never written to `.env`.
  - Models are listed in `infra/litellm/config.yaml`: gpt-5.5, gpt-5.4, gpt-5.4-mini (default), gpt-5.4-nano (small
    model) and gpt-4.1-mini.
  - `drop_params` is on. Prompts and responses are not stored in the spend logs.
- **Prices:** LiteLLM computes the cost of every request from its maintained model cost map. The map is fetched at
  startup (`LITELLM_LOCAL_MODEL_COST_MAP=False`), so the current OpenAI token prices are used. The admin console
  shows the prices in use (`/model/info`), e.g. gpt-5.4-mini: $0.75 input, $0.075 cached input, $4.50 output per 1M
  tokens.
- **Virtual key per agent:** the control plane holds the master key (`CW_LITELLM_MASTER_KEY`, prefixed so that a
  machine-wide `LITELLM_MASTER_KEY` cannot override it). It creates one virtual key per agent (`/key/generate`),
  stores it with the agent's secrets, and injects it as `AI_GATEWAY_API_KEY`. Agents never see the OpenAI key or the
  master key. Agents created before this change are provisioned and redeployed automatically at startup.
- **Spend limit instead of token budget:** each agent has `spendLimitUsd`, by default `AGENT_SPEND_LIMIT_USD=25`,
  per **rolling 30 days**.
  - **Checked via the LiteLLM API** before every step. The control plane sums the key's daily spend from
    `/spend/logs` over the last 30 days. If the limit is reached, the step is not started and the task ends as
    *budget exceeded* with a clear message.
  - **Backstop:** the key's LiteLLM budget (`max_budget`, `budget_duration: 30d`) stops a step that goes over the limit
    while running. The resulting LiteLLM error is mapped to the same outcome.
  - **Visible to users:** the status banner, the new-task form and the task page show "spent $x of $y in the last
    30 days". The admin console shows the spend per agent.
  - The per-task token budget is removed from the UI and the API; tasks still report the tokens they used.
- **Always a real model:** the mock model is removed from the stack. If no real model can be used — `OPENAI_API_KEY`
  missing, LiteLLM unreachable, or default model not configured — the admin console and the agent UI say what is
  wrong and what to configure. New tasks are blocked, and steps fail immediately with that message instead of
  retrying.

- **Managed in the admin console, not in the LiteLLM UI:** the agent's *AI & budget* tab covers the standard tasks:
  - 30-day spend with a daily chart;
  - spend limit and model;
  - the virtual key: masked value, alias, allowed models (the agent's model and the small model), LiteLLM backstop
    budget and reset date;
  - **Block / Unblock** and **Rotate** (new key, redeploy, old key deleted).

  All of it goes through the LiteLLM API and is audited (`agent.ai*`). The LiteLLM UI stays available for
  diagnostics.

## Azure

- **Option A:** LiteLLM as a Container App with Azure Database for PostgreSQL Flexible Server. The master key and the
  OpenAI key live in Key Vault.
- **Option B:** an API Management AI gateway in front of Azure OpenAI, with token metrics, per-subscription quotas
  and emitted cost.

The agents' contract — an OpenAI-compatible base URL plus a per-agent key — stays the same.

## Consequences

- Real cost: every task costs money from the configured OpenAI account, bounded per agent by the spend limit.
- Automated tests do not need a model: workflow tests use in-process activity stubs.
- Spend is current to within about 15 seconds (cache) plus LiteLLM's own spend-log flush interval.
