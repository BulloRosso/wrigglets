# ADR-0007: Agent Harness configuration and hardening (opencode 1.19)

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §5.2 step 4, §6.1–§6.3, §12, §21 open question 7

## Context

The spec marks the harness details "⚠ VERIFY". We verified them against **opencode 1.19.4** in a container with the
mock model (see `docs/architecture.md` §"Verification log").

## Findings and decisions

1. **Server auth:** `OPENCODE_SERVER_PASSWORD` enables HTTP basic auth, user name `opencode` (env
   `OPENCODE_SERVER_USERNAME` exists). Health endpoint is `GET /global/health` → `{healthy, version}`. ✔ as spec.
2. **SDK:** `@opencode-ai/sdk/v2` with flat parameters (`session.create({title})`, `session.prompt({sessionID, parts})`,
   `session.abort`, `session.messages`, `event.subscribe`, `permission.reply`). The wrapper `HarnessClient` isolates it.
3. **A turn = several assistant messages.** `session.prompt` returns only the *last* assistant message. Usage, tool calls
   and touched files are therefore aggregated over all assistant messages whose `parentID` is the user message.
4. **Config outside the workspace (open question 7 — resolved):** `OPENCODE_CONFIG=/tmp/harness/opencode.json`
   (rendered at boot), plus `OPENCODE_DISABLE_PROJECT_CONFIG=true` so that an `opencode.json` in the workspace is
   **ignored** (verified: a workspace config granting `bash: allow` had no effect). Because that flag also disables
   automatic `AGENTS.md` discovery, `AGENTS.md` is referenced explicitly via `"instructions": ["/home/workspace/AGENTS.md"]`
   (verified: instructions reach the model).
5. **Permission rules are ordered; the last match wins.** The spec's example (`…allow…, "*": "deny"` at the end) makes
   opencode remove the bash tool entirely. We put `"*": "deny"` **first**, then the allow-list (verified: `ls -la`
   allowed, `rm -rf …` denied with a tool error returned to the model).
6. `doom_loop` and `question` default to `ask` and would block a headless step → `deny`. Also denied: `webfetch`,
   `websearch`, `task`, `skill`, `lsp`, `external_directory`. Denied tool calls are *tool errors*, not permission
   prompts, so they do not fail the step; an unexpected `permission.asked` event is rejected and fails the step with
   `PermissionDenied`.
7. **Hardening flags:** `OPENCODE_DISABLE_AUTOUPDATE`, `…_MODELS_FETCH`, `…_DEFAULT_PLUGINS`, `…_CLAUDE_CODE`,
   `…_EXTERNAL_SKILLS`, `…_LSP_DOWNLOAD`, `…_EMBEDDED_WEB_UI`.
8. **Runtime npm access:** on first start opencode installs `@opencode-ai/plugin` into `~/.config/opencode`. The agent
   image **pre-warms** `HARNESS_HOME=/opt/harness-home` at build time so that the container starts without registry
   access (important with restricted egress on Azure).
9. The provider block uses `@ai-sdk/openai-compatible` with `{env:AI_GATEWAY_BASE_URL}` / `{env:AI_GATEWAY_API_KEY}`
   substitution (verified) and `enabled_providers: ["aigateway"]` so no other provider can be used.

## Consequences

- Users cannot change harness permissions through workspace files.
- Harness upgrades must re-run the verification (ordered rules, flags, prewarm).
