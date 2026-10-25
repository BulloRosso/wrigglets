# ADR-0013: Scripted OpenAI-compatible mock model for development and tests

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §12, §15 (mock OpenAI-compatible server), §16.3

## Decision

`apps/mock-llm` implements `POST /v1/chat/completions` (streaming and non-streaming, tool calls, usage) and
`GET /v1/models`, without dependencies. Behaviour:

- It reads the **last user message** and collects backticked paths that follow the word *write* on the same line —
  the convention our prompts follow ("Write the plan to `.agent/plans/<id>.md` …", step footer "write a … summary to
  `…`"). For each path not yet written in the current turn it calls the harness' write tool (detected from the tool
  schema: `write` with `filePath`/`content`), then answers with a short text.
- Test hook: "run the command `…`" makes it call the shell tool once (used to verify the permission rules).
- Requests without tools (title generation) get a short text.

The compose default points every agent at the mock (`AI_GATEWAY_BASE_URL=http://mock-llm:4010/v1`). For the real
AI gateway set base URL, key and model id in `.env` (and per agent in the admin console).

## Consequences

- The full flow (plan → approval → run → verify → finalize, timeline, audit export) runs locally without cost and
  deterministically; it does not test model quality.
- Open spec question §21.1 (AI gateway protocol) remains open; the provider block assumes OpenAI compatibility.
