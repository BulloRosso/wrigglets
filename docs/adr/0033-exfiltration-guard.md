# ADR-0033: Exfiltration guard: an evaluation agent in the harness's pre-tool hook

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

Agents run in the background and read untrusted text (web pages, documents, answers of other agents). A multi-turn
prompt injection can plant a goal early and let a later call of an *allowed* tool carry it out, for example sending
workspace data with an existing e-mail tool. The harness permissions (ADR-0007), the gateway allow-lists and the kill
switch (ADR-0021/0022) decide *which* tools may run, not *why* a call is made.

## Decision

- Use the **`tool.execute.before` hook of an opencode plugin**. It runs before every tool call and can veto it by
  throwing. The plugin is a generated, dependency-free file written by the harness supervisor outside the workspace; it
  only forwards the call to the agent server on loopback with a per-boot token and fails closed.
- An **evaluation agent**, a nano-class model (default: the platform small model) called with the agent's own LiteLLM
  key, decides. It receives the **last 5 model round-trips** of the harness session (prompts, agent text, tool calls and
  tool results) and the pending call, so it can see multi-turn attacks. The conversation is fenced as untrusted data.
- The **system prompt is tailored to multi-turn injection and data exfiltration** and is **editable in the admin
  console**. The JSON answer contract is appended by the platform. Model, context size, halt level and fail mode are
  configurable too. The configuration is owned by the control plane; agents fetch and cache it for 20 s.
- On a **block**: refuse the call, cancel the user's task (cancel update as `security-guard`), abort the harness session,
  and send a **`securityWarning` signal to the agent's `AgentWorkflow`**. The workflow applies the halt level at once (no
  new lock grants except cleanup) and runs an activity with retries that delivers the alert to the control plane. The
  control plane stores the alert, audits it, puts the agent on the kill-switch level (default `stopped`, which cancels all
  its tasks) and shows it on the dashboard. Acknowledging an alert and resuming the agent are separate admin actions.
- **A failing evaluation is not an attack:** with `failMode: block` (default) the call is refused and a `guard.error`
  audit entry is written, but nothing is halted.

## Alternatives considered

- *Check in the MCP gateway only:* misses the conversation context, and non-gateway tools (files, bash). The gateway has
  no view of earlier turns.
- *Evaluate with the agent's main model:* more capable but slower and expensive for every tool call; the prompt-injected
  model itself should not judge itself.
- *Report the alert only over HTTP:* loses the alert if the control plane is down. A Temporal signal plus a retried
  activity makes delivery durable, and puts the stop decision into the same coordination layer that owns the workspace
  lock.

## Consequences

- Every tool call costs one small-model call and adds its latency. Calls are counted in the agent's spend limit.
- The control is probabilistic; it complements the allow-lists and the kill switch, it does not replace them.
- Only tool calls are guarded. Output that people later render or forward is outside this control.
- The hook contract of opencode is a dependency; the plugin is covered by a test, but a harness upgrade needs a smoke
  test (see [exfiltration-guard.md](../exfiltration-guard.md#limits-you-should-know)).
- A false positive at `stopped` cancels all tasks of the agent; `paused` is the softer setting.

Details: [exfiltration-guard.md](../exfiltration-guard.md).
