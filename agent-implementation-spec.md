# Implementation Specification — "AI Colleague" (Agent Harness + Temporal on Azure)

> **Audience:** a coding agent that will implement this system end to end.
> **Status:** v1.0 · 2026-10-23
> **Reference diagrams:** `agent-temporal-architecture-always-on.svg` (technical), `agent-overview-management.svg` (management)

---

## 0. How to use this document

- Requirement keywords follow RFC 2119: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.
- Sections marked **⚠ VERIFY** contain API details that change between library versions. Before writing code against them, check the *installed, pinned* version's types or docs and adapt. Do not guess. If an API differs, keep the *intent* described here.
- Implement in the order of §20 (milestones). Every milestone has acceptance criteria; do not start the next milestone until they pass.
- When something in this spec is ambiguous or contradicts reality, stop and record it in `docs/decisions.md` (ADR style), choose the option that best preserves the goals in §1, and continue.

---

## 1. Goals and non-goals

### 1.1 Goals

1. A single AI "colleague" (the **agent**) that several people talk to through a React UI, signed in via **EasyAuth (Entra ID)**.
2. The agent works on **one shared data set**: the Git repository at `/home/workspace` on Azure App Service persistent storage.
3. **Temporal** frames all agent work. It MUST be possible to reconstruct exactly *who requested what, when, how it was done, who approved it, and what is scheduled for the future*.
4. The UI MUST visualize agent activity based on the Temporal Event History (activity timeline).
5. The agent MUST use the **AI gateway** ("Cost managed & governed models") as its only model provider.
6. Predictable fixed cost: **one** Azure App Service instance, Linux, plan **B2**, **Always On**.

### 1.2 Non-goals / hard constraints

- **MUST NOT fork** Temporal or the Agent Harness. Both are used as released, unmodified software.
- **MUST NOT** implement sleep/wake cycles, plan up/down-scaling, or scale-out. Instance count is fixed at 1.
- **MUST NOT** use Temporal Cloud. Temporal is always **self-hosted on Azure**.
- No multi-agent fleet in v1 (one agent, one workspace). The design SHOULD NOT preclude adding a second agent later (agent id is parameterized).

### 1.3 Terminology

| Term | Meaning |
|---|---|
| **Agent Harness** | The headless coding/working agent runtime. Implementation: **opencode**, run unmodified via `opencode serve`. In UI and docs always call it "Agent Harness". |
| **Agent** | The overall AI colleague (this application). |
| **Workspace** | `/home/workspace`, a Git repository, the single shared data set. |
| **Task** | One unit of work requested by a person or a schedule. One `TaskWorkflow` per task. |
| **Step** | One Agent Harness turn (plan, run, fix) executed inside one activity. |
| **Workspace lock** | Mutual exclusion so that only one task step mutates the workspace at a time. |

---

## 2. Architecture overview

```
Browser (React UI)
   │  HTTPS (EasyAuth / Entra ID)
   ▼
Azure App Service (Linux, B2, 1 instance, Always On)  ── VNet integration ──┐
 └─ one container
     ├─ Node.js process "server"
     │   ├─ API / BFF (Express)       ── Temporal client ───────────────────┤
     │   └─ Temporal Worker (queue "agent") ── poll/complete ───────────────┤
     │        └─ activities ──► Agent Harness (HTTP, 127.0.0.1:4096)        │
     └─ child process: Agent Harness (`opencode serve`) ──► AI gateway
   /home (Azure Storage, SMB) = workspace, harness data, artifacts           │
                                                                             ▼
Azure (private VNet): Temporal Server (self-hosted) + PostgreSQL Flexible Server + Temporal Web UI (ops)
```

### 2.1 Component responsibilities

| Component | Responsibility |
|---|---|
| React UI | Task submission, approvals, live progress, activity timeline, schedules, workspace browser, audit search. |
| API / BFF | Serves UI, authenticates via EasyAuth headers, authorizes via app roles, talks to Temporal (start/update/query/list/history), proxies live harness events (SSE), read-only workspace access, uploads. |
| Temporal Worker | Executes workflows (`AgentWorkflow`, `TaskWorkflow`, `MaintenanceWorkflow`) and activities (harness steps, verification, Git, artifacts, notifications). |
| Agent Harness | Performs the actual work inside the workspace using models of the AI gateway. Has no knowledge of Temporal. |
| Temporal Server | Durable execution, Event History, schedules/timers, visibility (search attributes). |
| PostgreSQL | Temporal persistence + visibility store. |
| Temporal Web UI | Operator/debugging tool only, not for end users. |
| AI gateway | Model provider for the harness. |

### 2.2 Key design decisions (do not change without an ADR)

1. **One activity = one harness step.** Temporal never sees individual LLM calls.
2. **Workspace serialization** via a singleton `AgentWorkflow` acting as a FIFO lock manager. Locks are held only during mutating phases (steps, Git commits), **never while waiting for a human**.
3. **Two audit pillars:** Temporal history (who/when/why/what next) + Git history (what exactly changed), linked by `Workflow-Id` trailers. Because Temporal retention is finite, a permanent **audit export** is written into the workspace at task completion (§7.9).
4. **Identity is server-side only.** The API derives the user from EasyAuth headers; the client never supplies identity.
5. **Everything that changes the workspace goes through a TaskWorkflow**, including user file uploads, so that every change is traceable.

---

## 3. Repository layout

Use a **pnpm workspace monorepo**, TypeScript everywhere, Node.js **22 LTS**.

```
/
├─ apps/
│  ├─ web/                    # React + Vite UI
│  └─ server/                 # API + Worker + harness supervisor (one process)
│     ├─ src/
│     │  ├─ main.ts           # boot sequence (§5)
│     │  ├─ config.ts         # env parsing (zod)
│     │  ├─ api/              # express routers, middleware
│     │  ├─ harness/          # process supervisor + client wrapper
│     │  ├─ temporal/         # client + worker bootstrap, data converter
│     │  ├─ activities/       # activity implementations
│     │  ├─ timeline/         # history → timeline mapping
│     │  └─ workspace/        # git + fs helpers (path safety)
│     └─ test/
├─ packages/
│  ├─ workflows/              # deterministic workflow code ONLY (bundled)
│  ├─ shared/                 # zod schemas, DTOs, search attribute keys, constants
│  └─ harness-config/         # opencode.json template + AGENTS.md template
├─ infra/
│  ├─ bicep/                  # all Azure resources (§14)
│  └─ temporal/               # server config template, schema job, bootstrap scripts
├─ deploy/
│  ├─ Dockerfile
│  └─ startup.sh
├─ docs/
│  ├─ decisions.md
│  └─ runbook.md
└─ .github/workflows/         # CI/CD (§17)
```

Rules:
- `packages/workflows` MUST import only from `@temporalio/workflow`, `packages/shared` (pure types/constants), and type-only imports of activities. No Node APIs, no `Date.now()`, no `Math.random()`, no I/O.
- Shared DTOs and validation live in `packages/shared` and are used by API, workflows (types only), and UI.

---

## 4. Configuration

All configuration comes from environment variables (App Settings), parsed and validated with zod in `apps/server/src/config.ts`. The process MUST fail fast on invalid config.

| Variable | Example | Notes |
|---|---|---|
| `PORT` / `WEBSITES_PORT` | `8080` | App Service sets `WEBSITES_PORT` for custom containers. |
| `NODE_ENV` | `production` | |
| `AGENT_ID` | `max` | Used in workflow ids, git author. |
| `AGENT_DISPLAY_NAME` | `Max` | |
| `AGENT_GIT_EMAIL` | `agent-max@example.com` | |
| `HOME_ROOT` | `/home` | Override for local dev. |
| `WORKSPACE_DIR` | `/home/workspace` | |
| `ARTIFACTS_DIR` | `/home/artifacts` | |
| `STAGING_DIR` | `/home/staging` | Uploads before they enter the workspace. |
| `HARNESS_DATA_DIR` | `/home/.oc` | Becomes `XDG_DATA_HOME` for the harness. See §6.6 fallback. |
| `HARNESS_PORT` | `4096` | Bound to 127.0.0.1 only. |
| `HARNESS_PASSWORD` | *(generated at boot)* | Never configured externally; generated per process start. |
| `HARNESS_VERSION` | `x.y.z` | Pinned; must match Docker image. |
| `TEMPORAL_ADDRESS` | `temporal-frontend.internal:7233` | Private endpoint in VNet. |
| `TEMPORAL_NAMESPACE` | `agent-prod` | |
| `TEMPORAL_TASK_QUEUE` | `agent` | |
| `TEMPORAL_TLS_CERT` / `TEMPORAL_TLS_KEY` / `TEMPORAL_TLS_CA` | Key Vault refs | mTLS client cert (§13). |
| `PAYLOAD_CODEC_KEY` | Key Vault ref | AES-256-GCM key for payload encryption (§7.10). |
| `AI_GATEWAY_BASE_URL` | `https://…` | ⚠ Confirm endpoint and protocol (§12). |
| `AI_GATEWAY_API_KEY` | Key Vault ref | |
| `AI_GATEWAY_MODEL` | `aigateway/<model-id>` | Default model for harness. |
| `TASK_DEFAULT_TOKEN_BUDGET` | `400000` | Per task, all steps combined. |
| `TASK_MAX_FIX_ROUNDS` | `2` | Verify→fix loop limit. |
| `APPROVAL_REMINDER_AFTER` | `4h` | |
| `APPROVAL_EXPIRE_AFTER` | `7d` | Task is cancelled after this. |
| `NOTIFY_TEAMS_WEBHOOK_URL` | Key Vault ref | Optional. |
| `ENTRA_ROLE_USER` / `_APPROVER` / `_ADMIN` | `Agent.User` … | App role names. |
| `DEV_FAKE_USER` | `anna@example.com` | Only honored if `NODE_ENV=development`. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | | |

Secrets MUST be App Service **Key Vault references** (`@Microsoft.KeyVault(...)`), resolved via the Web App's system-assigned managed identity.

---

## 5. Process model and boot sequence

One container, one Node process (`apps/server`), plus the Agent Harness as a **supervised child process**.

### 5.1 `deploy/Dockerfile` (requirements)

- Base: `node:22-bookworm-slim`.
- Install: `git`, `ca-certificates`, `tini`, `python3` + `python3-venv` (the harness may run analysis scripts), `ripgrep`.
- Install the Agent Harness **pinned**: `npm i -g opencode-ai@${HARNESS_VERSION}` ⚠ VERIFY package name and that the binary is `opencode`.
- Copy built `apps/server/dist`, the prebuilt workflow bundle (§7.1), and `apps/web/dist` into `/app`. **Nothing from the app goes into `/home`.** `node_modules` stay in `/app`.
- `ENTRYPOINT ["/usr/bin/tini","--"]`, `CMD ["/app/deploy/startup.sh"]`.
- Run as a non-root user where App Service allows; `/home` must be writable by that user.

### 5.2 Boot sequence (`main.ts`)

1. Parse config. Initialize OpenTelemetry/App Insights.
2. **Prepare `/home`:** create `workspace`, `artifacts`, `staging`, `.oc` if missing. If `workspace/.git` does not exist: `git init -b main`, write `.gitignore` (§8.1), `AGENTS.md` from template, commit `chore: initialize workspace` with trailer `Requested-By: system`.
3. Configure Git for the workspace: `user.name = AGENT_DISPLAY_NAME`, `user.email = AGENT_GIT_EMAIL`, `core.fsmonitor=false`, `gc.auto=0` (run gc only in maintenance, §7.8).
4. Write/refresh the harness config: render `packages/harness-config/opencode.json` to `/home/workspace/opencode.json` **only if content changed**, committing it as `chore: update harness config`. (Alternative: global config dir; ⚠ VERIFY which config locations the pinned harness reads and prefer a location outside the workspace if supported, so users cannot alter permissions through workspace edits.)
5. **Start the harness** (§6.1) and wait until `GET /global/health` (⚠ VERIFY path) reports healthy, with a 60 s timeout.
6. Connect the Temporal client (`Connection.connect`) and the worker connection (`NativeConnection.connect`), both with mTLS and the payload codec.
7. **Ensure singleton `AgentWorkflow`** (§7.4): start with `workflowId = agent-${AGENT_ID}`, conflict policy "use existing" ⚠ VERIFY option name (`workflowIdConflictPolicy: 'USE_EXISTING'`).
8. Ensure system schedules exist (§7.8).
9. Start Express on `WEBSITES_PORT`.
10. Create and `run()` the worker.

### 5.3 Graceful shutdown (SIGTERM from App Service on restart/deploy)

1. Stop accepting new HTTP requests; close SSE streams with a `retry:` hint.
2. `worker.shutdown()`. In-flight activities receive cancellation; `runAgentStep` MUST call harness `abort` for its session (§6.4).
3. Wait up to 20 s, then SIGTERM the harness child, then exit.
4. Unfinished activities are retried by Temporal after restart. Idempotency is guaranteed by Git checkpoints (§8.3).

### 5.4 Harness supervision

- If the harness exits unexpectedly: log, restart with exponential backoff (1 s → 30 s). Activities in flight fail with a retryable error.
- Expose harness state in `/health` (degraded if harness down > 60 s).

---

## 6. Agent Harness integration

### 6.1 Starting the harness

Spawn as a child process (do **not** use the SDK's embedded server helper, so that we control env and lifecycle):

```
opencode serve --hostname 127.0.0.1 --port ${HARNESS_PORT}
```

with environment:

| Env | Value |
|---|---|
| `OPENCODE_SERVER_PASSWORD` | random 32-byte hex, generated at boot, kept in memory |
| `XDG_DATA_HOME` | `HARNESS_DATA_DIR` |
| `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY` | passed through for config substitution |
| `HOME` | a local, non-persistent dir (e.g. `/tmp/harness-home`) to avoid stray dotfiles in `/home` |
| cwd | `WORKSPACE_DIR` |

The harness MUST NOT be reachable from outside the container (bind 127.0.0.1 only; App Service only routes to `WEBSITES_PORT`).

### 6.2 Harness configuration (`opencode.json` template)

⚠ VERIFY every key against the config schema of the pinned version (`$schema` URL). Intent:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "share": "disabled",
  "provider": {
    "aigateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AI gateway",
      "options": {
        "baseURL": "{env:AI_GATEWAY_BASE_URL}",
        "apiKey": "{env:AI_GATEWAY_API_KEY}"
      },
      "models": {
        "<model-id>": { "name": "<display name>" }
      }
    }
  },
  "model": "aigateway/<model-id>",
  "permission": {
    "edit": "allow",
    "webfetch": "deny",
    "bash": {
      "git status*": "allow",
      "git diff*": "allow",
      "git log*": "allow",
      "ls*": "allow",
      "cat *": "allow",
      "rg *": "allow",
      "python3 /home/workspace/scripts/*": "allow",
      "*": "deny"
    }
  }
}
```

Rules:
- No permission may be `"ask"`. In headless mode a pending permission would block the step. Anything not explicitly allowed is `deny`.
- `git commit`, `git reset`, `git push` MUST be denied for the harness. **Only activities commit** (§8).
- Network access other than the AI gateway SHOULD be denied.
- `AGENTS.md` (workspace root) contains standing instructions: role, tone, folder conventions, "never commit", "write plans to `.agent/plans/<taskId>.md`", "write summaries to `.agent/summaries/<taskId>-<step>.md`".

### 6.3 Client wrapper (`apps/server/src/harness/client.ts`)

Use `@opencode-ai/sdk` pinned to the same version as the binary. ⚠ VERIFY method names and argument shapes. Wrap the SDK so that the rest of the code depends only on this interface:

```ts
export interface HarnessClient {
  health(): Promise<{ healthy: boolean; version: string }>;
  createSession(input: { title: string }): Promise<{ sessionId: string }>;
  prompt(input: {
    sessionId: string;
    text: string;
    model?: { providerID: string; modelID: string };
    signal?: AbortSignal;
  }): Promise<HarnessTurnResult>;
  abort(sessionId: string): Promise<void>;
  messages(sessionId: string): Promise<HarnessMessage[]>;
  events(signal: AbortSignal): AsyncIterable<HarnessEvent>; // SSE /event
}

export interface HarnessTurnResult {
  finalText: string;              // last assistant text part
  tokens: { input: number; output: number; reasoning?: number; cacheRead?: number };
  cost?: number;                  // if reported by harness
  toolCalls: Array<{ tool: string; status: 'ok' | 'error'; title?: string }>;
  filesTouched: string[];         // from edit/write tool parts, relative to workspace
  error?: { kind: 'aborted' | 'provider' | 'permission' | 'unknown'; message: string };
}
```

Authentication: the SDK client MUST send `Authorization: Basic base64("opencode:" + password)` ⚠ VERIFY username default; implement via a custom `fetch` that injects the header.

### 6.4 Event handling

- One long-lived subscription to the harness event stream per process, fanned out in-process via an `EventEmitter` keyed by `sessionId`.
- Consumers:
  - `runAgentStep` uses events for **heartbeats** (§7.6).
  - the SSE endpoint `/api/tasks/:id/live` streams sanitized events to the UI (§9).
- If a permission-request event is ever observed (should not happen with the config above), immediately reject it via the API ⚠ VERIFY endpoint, abort the session, and fail the step with non-retryable `PermissionDenied`.

### 6.5 Sessions

- **One harness session per task**, created lazily in the first step, id stored in workflow state.
- Steps MUST be robust to losing the session (harness restart, data dir loss): if the session is missing, create a new session and include a context preamble: task instructions, approved plan (from `.agent/plans/<taskId>.md`), previous step summaries. **The workspace, not the session, is the memory.**

### 6.6 Harness data on SMB

`/home` is an SMB mount. The harness data store MAY have locking or latency issues there.
- M1 test (§20): run 50 consecutive prompts; check for errors or corruption.
- If problems appear, set `HARNESS_DATA_DIR=/tmp/oc` (ephemeral). Sessions are then lost on restart, which §6.5 already tolerates. Transcripts are exported per step to `/home/artifacts` anyway (§7.6).

---

## 7. Temporal design

### 7.1 General

- SDK: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`, `@temporalio/common`, all pinned to the same version.
- Namespace: `agent-prod` (`agent-dev` for dev). Retention: **90 days** (§7.9 covers permanent audit).
- Task queue: `agent`.
- Workflow code is pre-bundled at build time with `bundleWorkflowCode` and loaded via `workflowBundle: { codePath }` (faster cold start, deterministic deploys).
- **Payload limits:** workflow/activity inputs and outputs MUST stay small (target < 50 KB, hard cap 256 KB). Large content (diffs, transcripts, reports) goes to `/home/artifacts` and is referenced by relative path.
- **Versioning:** any change to workflow logic affecting command order MUST use `patched('<change-id>')`, or be deployed only when no affected workflows are running. Record replay histories (§16.2).

### 7.2 Identifiers

| Entity | Workflow / Schedule ID |
|---|---|
| Agent singleton | `agent-${AGENT_ID}` |
| Task | `task-${ULID}` (ULID generated in the API, sortable) |
| Schedule | `sched-${slug}` (slug from title, unique) |
| Maintenance | `maint-${kind}-${date}` |

### 7.3 Custom search attributes

Register once per namespace (bootstrap script §14.5):

| Name | Type | Set by |
|---|---|---|
| `AgentId` | Keyword | all |
| `RequestedBy` | Keyword | TaskWorkflow (UPN, lowercase) |
| `TaskType` | Keyword | `analysis`, `change`, `report`, `upload`, `maintenance` |
| `TaskStatus` | Keyword | see §7.5 states |
| `TaskTitle` | Text | TaskWorkflow |
| `Trigger` | Keyword | `user`, `schedule` |
| `ScheduleId` | Keyword | if `Trigger=schedule` |
| `ApprovedBy` | KeywordList | TaskWorkflow |

Define keys once in `packages/shared/src/searchAttributes.ts` using the typed search attribute API ⚠ VERIFY (`defineSearchAttributeKey`, `TypedSearchAttributes`, the workflow-side upsert function name). Status changes MUST be upserted so that the UI can list tasks by status via visibility queries.

### 7.4 `AgentWorkflow` (singleton, workspace lock manager)

**Purpose:** FIFO mutual exclusion over the workspace, plus agent-level status.

State:
```ts
interface AgentState {
  agentId: string;
  holder?: { taskId: string; since: string /* ISO, from workflow clock */ };
  waiting: Array<{ taskId: string; requestedAt: string }>;
  stats: { grantsTotal: number };
}
```

Messages:
| Kind | Name | Payload | Behavior |
|---|---|---|---|
| Signal | `acquire` | `{ taskId }` | Append to `waiting` unless already holder or waiting (idempotent). |
| Signal | `release` | `{ taskId }` | If `holder.taskId === taskId`, clear holder. Otherwise ignore (idempotent). |
| Query | `status` | – | `{ holder, waiting, stats }` |
| Signal | `forceRelease` | `{ taskId, by }` | Admin only (API enforces role). Clears holder; recorded in history. |

Main loop:
```ts
while (true) {
  await condition(() => (!state.holder && state.waiting.length > 0) || shouldContinueAsNew(), STALE_CHECK_INTERVAL /* 5 min */);
  if (shouldContinueAsNew()) break;
  if (!state.holder && state.waiting.length > 0) {
    const next = state.waiting.shift()!;
    state.holder = { taskId: next.taskId, since: new Date().toISOString() }; // workflow Date is deterministic
    await getExternalWorkflowHandle(next.taskId).signal(grantedSignal, { taskId: next.taskId });
    state.stats.grantsTotal++;
  } else if (state.holder) {
    // stale-lock protection: holder workflow closed without releasing
    const running = await acts.isWorkflowRunning({ workflowId: state.holder.taskId });
    if (!running) state.holder = undefined;
  }
}
await condition(allHandlersFinished);
await continueAsNew<typeof agentWorkflow>(state);
```

- `shouldContinueAsNew()` uses `workflowInfo().continueAsNewSuggested` ⚠ VERIFY, or history length > 5,000 events.
- If signalling `granted` fails because the task workflow no longer exists, skip it and continue.
- `isWorkflowRunning` is a local activity using the Temporal client (`describe`).

### 7.5 `TaskWorkflow`

**Input** (`packages/shared`):
```ts
interface TaskInput {
  taskId: string;                    // == workflowId
  agentId: string;
  title: string;                     // ≤ 120 chars
  instructions: string;              // ≤ 20,000 chars
  type: 'analysis' | 'change' | 'report' | 'upload';
  requestedBy: { upn: string; name: string; oid: string };
  trigger: { kind: 'user' } | { kind: 'schedule'; scheduleId: string; owner: string };
  approval: 'plan' | 'none' | 'deviation';   // 'deviation' = only if verify flags anomalies
  budget: { maxTokens: number };
  attachments?: string[];            // staging paths for type 'upload'
}
```

**States** (also `TaskStatus` search attribute):
`queued → planning → awaiting_approval → running → verifying → (fixing ↔ verifying)* → completed`
plus terminal `rejected`, `cancelled`, `failed`, `budget_exceeded`, `expired`.

**Messages:**
| Kind | Name | Payload | Validator / rules |
|---|---|---|---|
| Update | `decide` | `{ decision: 'approve' \| 'reject' \| 'revise', comment?: string, by: Identity }` | Only valid in `awaiting_approval`. Caller must have role Approver **or** be the requester (configurable). `revise` requires a comment. |
| Update | `cancel` | `{ by: Identity, reason?: string }` | Not valid in terminal states. |
| Update | `comment` | `{ by: Identity, text: string }` | Any state; appended to task notes, shown in timeline. |
| Signal | `granted` | `{ taskId }` | From AgentWorkflow. |
| Query | `state` | – | Full `TaskState` (§7.5.2). |

The `by` identity in updates is supplied **by the API** from EasyAuth, never by the browser.

#### 7.5.1 Flow

```ts
export async function taskWorkflow(input: TaskInput): Promise<TaskResult> {
  setupHandlers();                          // decide, cancel, comment, granted, state
  setStatus('queued');

  try {
    if (input.type === 'upload') {
      await withWorkspace(input.taskId, () => acts.applyUpload({ ... }));
      return finish('completed');
    }

    // 1. PLAN (needs lock: harness writes the plan file)
    setStatus('planning');
    const plan = await withWorkspace(input.taskId, () => step('plan', planPrompt(input)));

    // 2. APPROVAL (no lock held!)
    if (input.approval === 'plan') {
      const decision = await awaitDecision();   // reminders + expiry timers
      if (decision.decision === 'reject') return finish('rejected');
      if (decision.decision === 'revise') { /* loop back to plan with comment, max 3 revisions */ }
    }

    // 3. RUN + VERIFY + FIX (lock held for each mutating step separately)
    setStatus('running');
    await withWorkspace(input.taskId, () => step('run', runPrompt(input, state.approvedPlan)));

    for (let round = 0; ; round++) {
      setStatus('verifying');
      const v = await withWorkspace(input.taskId, () => acts.verify({ taskId: input.taskId, type: input.type }));
      if (v.ok) break;
      if (round >= MAX_FIX_ROUNDS) return finish('failed', { reason: 'verification failed', report: v.reportPath });
      setStatus('fixing');
      await withWorkspace(input.taskId, () => step('fix', fixPrompt(v)));
    }

    // 4. Deviation approval (optional)
    if (input.approval === 'deviation' && state.verify?.anomalies?.length) { await awaitDecision(); /* ... */ }

    // 5. FINALIZE
    await withWorkspace(input.taskId, () => acts.finalizeTask({ taskId: input.taskId, ... })); // final commit + audit export (§7.9)
    await acts.notify({ to: input.requestedBy, kind: 'completed', taskId: input.taskId });
    return finish('completed');
  } catch (err) {
    if (isCancellation(err)) { await nonCancellable(() => cleanup('cancelled')); throw err; }
    if (isBudgetExceeded(err)) return finish('budget_exceeded');
    await nonCancellable(() => cleanup('failed'));
    throw err;
  }
}
```

`step(kind, prompt)` is a helper that:
1. checks the remaining token budget (fail with `budget_exceeded` before starting if < 5 %),
2. calls `runAgentStep` with an activity **summary** (⚠ VERIFY whether the pinned SDK supports a per-call `summary` option; if not, put a `summary` field into the activity input),
3. adds returned token usage to `state.usage`,
4. appends `{ kind, summary, commit, artifacts }` to `state.steps`.

`withWorkspace(taskId, fn)`:
```ts
async function withWorkspace<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  state.lock = 'waiting';
  await getExternalWorkflowHandle(agentWorkflowId).signal(acquireSignal, { taskId });
  await condition(() => lockGranted);
  state.lock = 'held';
  try {
    return await fn();
  } finally {
    lockGranted = false;
    state.lock = 'none';
    await CancellationScope.nonCancellable(() =>
      getExternalWorkflowHandle(agentWorkflowId).signal(releaseSignal, { taskId }));
  }
}
```

`awaitDecision()`:
- `setStatus('awaiting_approval')`, `notify` the requester (and approvers if configured).
- Wait with `condition(() => !!pendingDecision, APPROVAL_REMINDER_AFTER)`; on timeout send a reminder, then wait until `APPROVAL_EXPIRE_AFTER` → `expired`.
- Record `approvedBy` and upsert `ApprovedBy`.

#### 7.5.2 `TaskState` (query result, also used by UI)

```ts
interface TaskState {
  taskId: string; title: string; type: TaskInput['type'];
  status: TaskStatus; lock: 'none' | 'waiting' | 'held';
  requestedBy: Identity; trigger: TaskInput['trigger'];
  sessionId?: string;
  plan?: { path: string; summary: string; commit: string };
  approvedPlan?: { path: string; decidedBy: Identity; comment?: string; at: string };
  steps: Array<{ kind: 'plan'|'run'|'fix'; summary: string; commit: string; startedAt: string; endedAt: string; tokens: number; artifacts: string[] }>;
  verify?: { ok: boolean; reportPath: string; anomalies?: string[] };
  usage: { tokens: number; maxTokens: number; cost?: number };
  notes: Array<{ by: Identity; text: string; at: string }>;
  result?: { summary: string; outputs: string[]; finalCommit: string };
}
```

### 7.6 Activities

All activities live in `apps/server/src/activities`, are pure functions of their inputs plus the injected dependencies (harness client, git, fs, config), and are **idempotent** (§8.3).

| Activity | Input → Output | Timeouts / retry |
|---|---|---|
| `runAgentStep` | `{ taskId, stepId, kind, prompt, sessionId?, checkpoint?, budgetRemaining }` → `{ sessionId, summary, commit, tokens, cost?, artifacts, filesTouched }` | startToClose 60 min, **heartbeat 2 min**, retry max 3, backoff 30 s ×2. Non-retryable: `BudgetExceeded`, `PermissionDenied`, `HarnessConfigError`. |
| `verify` | `{ taskId, type }` → `{ ok, reportPath, anomalies? }` | startToClose 10 min, retry 2. |
| `applyUpload` | `{ taskId, files: StagingFile[], requestedBy }` → `{ commit, paths }` | 5 min, retry 3. |
| `finalizeTask` | `{ taskId, state }` → `{ finalCommit, auditPath }` | 5 min, retry 5. |
| `notify` | `{ to, kind, taskId, text? }` → void | 1 min, retry 5, failures do not fail the task (catch in workflow and log). |
| `isWorkflowRunning` (local) | `{ workflowId }` → boolean | 10 s. |
| `gitMaintenance` | `{}` → `{ before, after }` | 30 min. |
| `backupWorkspace` | `{ date }` → `{ blobUrl }` | 30 min, retry 3. |

#### `runAgentStep` in detail

1. **Checkpoint/idempotency** (§8.3): read `HEAD`. If a commit with trailer `Step-Id: <stepId>` already exists, return its recorded result from `.agent/steps/<stepId>.json` (step already completed before a crash). Otherwise, if the working tree is dirty, `git reset --hard <checkpoint or HEAD>` and `git clean -fd -e .agent/steps/`.
2. Ensure session (§6.5). Subscribe to events for that session.
3. **Heartbeat** on every harness event, and at least every 30 s while the prompt is running (timer fallback). Heartbeat details: `{ lastEventType, toolCalls }`.
4. On `Context.current().cancellationSignal`: call `harness.abort(sessionId)`, then rethrow.
5. Send the prompt. Before sending, append a step footer to the prompt: *"When finished, write a 3–6 sentence summary to `.agent/summaries/<taskId>-<stepId>.md`. Do not commit."*
6. Evaluate the result: on `error.kind === 'provider'` throw retryable; on `permission` throw non-retryable.
7. **Budget:** if `tokens.total > budgetRemaining`, still commit the work (traceability), then throw non-retryable `BudgetExceeded` after commit.
8. Export the transcript (`harness.messages`) as JSON to `/home/artifacts/<taskId>/<stepId>-transcript.json`; write `.agent/steps/<stepId>.json` with the result.
9. **Commit** (§8.2) all changes, with trailers. Return a small result (no file contents).

#### `verify`

Deterministic checks, no LLM:
- `git diff --name-only <task base>..HEAD` must only touch allowed paths (no `.git`, no `opencode.json`, no `AGENTS.md` unless type permits).
- Summary file exists for each step.
- Type-specific checks, plug-in style: `/home/workspace/scripts/verify/<type>.py` or `<type>.ts` if present (e.g. "all offers covered", "sums plausible"); exit code 0 = ok, stdout JSON = anomalies.
- Writes a report to `/home/artifacts/<taskId>/verify-<n>.md`.

### 7.7 Schedules (future work)

- Created via API (§9) with `client.schedule.create` ⚠ VERIFY shape. Action: start `taskWorkflow` with `workflowId` prefix `task-sched-${scheduleId}`, task queue `agent`, and args built from the schedule definition (title, instructions, type, approval policy, owner identity, budget).
- Schedule **memo** stores `{ owner: Identity, createdBy: Identity, createdAt }`; search attributes `AgentId`, `RequestedBy=owner`.
- Overlap policy: **skip** if a previous run is still running ⚠ VERIFY enum name.
- Timezone: `Europe/Berlin` via the calendar spec timezone field.
- Edits (pause/resume/update/delete) are performed by the API with the caller's identity recorded in the schedule memo `history` array (last 50 changes) **and** in an application audit log entry (§9.4).
- One-off future tasks: use a schedule with a single calendar time, or start the TaskWorkflow with `startDelay` ⚠ VERIFY. Both are visible through visibility queries.

### 7.8 System schedules (created at boot if missing)

| Schedule | Cron (Europe/Berlin) | Workflow | Purpose |
|---|---|---|---|
| `sched-sys-git-maintenance` | Sun 03:10 | `maintenanceWorkflow({ kind: 'git' })` | `git gc --prune=30.days`, integrity check (`git fsck`). Acquires workspace lock. |
| `sched-sys-backup` | daily 02:40 | `maintenanceWorkflow({ kind: 'backup' })` | `git bundle create --all` → Azure Blob (managed identity), keep 35 daily. Acquires lock. |
| `sched-sys-artifact-cleanup` | daily 03:40 | `maintenanceWorkflow({ kind: 'artifacts' })` | Delete transcripts older than 180 days (audit exports are kept forever). |

### 7.9 Permanent audit export

Temporal retention is 90 days. To keep the audit trail permanently, `finalizeTask` (also called from `cleanup` for failed/rejected/cancelled/expired tasks) MUST:
1. Fetch the workflow history via the client (`handle.fetchHistory()`), decode payloads (with codec).
2. Produce `/home/workspace/.agent/audit/<yyyy>/<mm>/<taskId>.json` containing: task input (minus attachments content), final `TaskState`, the mapped timeline (§10), and the raw history in JSON.
3. Commit with trailer `Audit-Export: <taskId>`.

Since the workflow is still running when `finalizeTask` executes, the export contains everything up to finalization; the final completion event is implied by the commit. That is acceptable.

### 7.10 Data converter / payload encryption

Prompts and results may contain business data and are stored in Temporal's PostgreSQL. Implement a **payload codec** (AES-256-GCM, key from `PAYLOAD_CODEC_KEY`, key id in payload metadata to allow rotation) used by client and worker.
- Provide a small **codec server** endpoint in the API (`/codec/decode`, `/codec/encode`, CORS limited to the Temporal Web UI origin, admin role required) so operators can read histories in the Temporal Web UI ⚠ VERIFY the codec endpoint contract expected by the pinned Temporal UI version.
- The timeline API decodes server-side.

---

## 8. Workspace and Git conventions

### 8.1 Layout

```
/home/workspace/
├─ AGENTS.md                # standing instructions for the harness
├─ opencode.json            # harness config (unless placed outside, see §5.2 step 4)
├─ .gitignore               # ignores: .agent/steps/*.tmp, __pycache__, .venv, node_modules
├─ .agent/
│  ├─ plans/<taskId>.md
│  ├─ summaries/<taskId>-<stepId>.md
│  ├─ steps/<stepId>.json
│  └─ audit/<yyyy>/<mm>/<taskId>.json
├─ scripts/verify/          # optional type-specific verification
└─ … team data (documents, CSV, reports)
```

### 8.2 Commits

- **Only activities commit.** One commit per step (plus upload, finalize, maintenance).
- Author: `AGENT_DISPLAY_NAME <AGENT_GIT_EMAIL>`. If a human is the originator (upload), set `--author` to the human and keep committer = agent.
- Message format:
  ```
  <type>(<taskId>): <step kind> — <short summary, ≤ 72 chars>

  <optional body: summary file content>

  Requested-By: anna@example.com
  Approved-By: ben@example.com
  Task-Id: task-01JB…
  Workflow-Id: task-01JB…
  Run-Id: 3f2c…
  Step-Id: task-01JB…:run:1
  Trigger: user
  ```
- Empty steps produce an `--allow-empty` commit so that every step is visible in Git.
- The harness's own git commands are limited to read-only (§6.2).

### 8.3 Idempotency and checkpoints

- `stepId = <taskId>:<kind>:<attempt counter maintained in workflow state>`. It is deterministic, so retries of the same activity use the same `stepId`.
- Before a step: if a commit with `Step-Id: <stepId>` exists → return the stored result (no re-execution).
- Otherwise reset the working tree to `HEAD` (the last committed checkpoint) and clean untracked files except `.agent/steps/`.
- Because of the workspace lock, no other task commits between checkpoint and step, so `HEAD` is a valid checkpoint.

### 8.4 Path safety

All API file access goes through `resolveWorkspacePath(relPath)`:
- reject absolute paths, `..` segments after normalization, NUL bytes, symlinks escaping the workspace (check `realpath`),
- deny `.git/**`,
- read-only for users. Writes happen only via `applyUpload` and harness steps.

---

## 9. API specification

Express, JSON, zod-validated. All routes except `/health` require an authenticated EasyAuth principal.

### 9.1 Identity middleware

```ts
// x-ms-client-principal: base64(JSON { auth_typ, name_typ, role_typ, claims: [{ typ, val }] })
export function identity(req, res, next) {
  const raw = req.header('x-ms-client-principal');
  if (!raw) {
    if (config.NODE_ENV === 'development' && config.DEV_FAKE_USER) { req.user = fakeUser(); return next(); }
    return res.status(401).end();
  }
  const p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  const claim = (t: string) => p.claims.find((c) => c.typ === t)?.val;
  const roles = p.claims.filter((c) => c.typ === 'roles' || c.typ === p.role_typ).map((c) => c.val);
  req.user = {
    upn: (claim('preferred_username') ?? claim(p.name_typ) ?? '').toLowerCase(),
    name: claim('name') ?? '',
    oid: claim('http://schemas.microsoft.com/identity/claims/objectidentifier') ?? claim('oid') ?? '',
    roles,
  };
  if (!req.user.upn || !req.user.oid) return res.status(401).end();
  next();
}
```

- Requests must come through EasyAuth. In production the app MUST reject requests without the header (EasyAuth is configured to require authentication, so this only matters for misconfiguration).
- Authorization: `Agent.User` required for everything; `Agent.Approver` for decisions on others' tasks; `Agent.Admin` for force-release, codec, system schedules.

### 9.2 Endpoints

| Method & path | Role | Body / query | Response | Temporal operation |
|---|---|---|---|---|
| `GET /health` | none | – | `{ status, harness, temporal, version }` | describe namespace (cached 30 s) |
| `GET /api/me` | User | – | identity + roles | – |
| `GET /api/agent/status` | User | – | `{ holder, waiting, health }` | query `status` on AgentWorkflow |
| `POST /api/tasks` | User | `{ title, instructions, type, approval?, maxTokens? }` | `{ taskId }` | `workflow.start(taskWorkflow, { workflowId, typedSearchAttributes, memo })` |
| `GET /api/tasks` | User | `status?, requestedBy?, type?, from?, to?, pageToken?` | page of `TaskListItem` | `workflow.list({ query })` (visibility, `AgentId = '<id>'` always added) |
| `GET /api/tasks/:id` | User | – | `TaskState` + describe info | query `state`; fall back to audit export if closed beyond retention |
| `POST /api/tasks/:id/decision` | Approver or requester | `{ decision, comment? }` | updated `TaskState` | `executeUpdate(decide, { args: [{ ..., by: req.user }] })` |
| `POST /api/tasks/:id/cancel` | requester or Admin | `{ reason? }` | `TaskState` | `executeUpdate(cancel)` |
| `POST /api/tasks/:id/comments` | User | `{ text }` | `TaskState` | `executeUpdate(comment)` |
| `GET /api/tasks/:id/timeline` | User | – | `Timeline` (§10) | `fetchHistory()` + mapping |
| `GET /api/timeline` | User | `from, to` | `Timeline` across tasks (lanes per task) | list + histories (cached) |
| `GET /api/tasks/:id/live` | User | – | **SSE** stream of sanitized harness events | in-process event bus |
| `GET /api/schedules` | User | – | list | `schedule.list()` |
| `POST /api/schedules` | User | `{ title, instructions, type, approval, calendar, timezone? }` | `{ scheduleId }` | `schedule.create` |
| `PATCH /api/schedules/:id` | owner or Admin | partial / `{ paused }` | schedule | `handle.update` / `pause` / `unpause` |
| `DELETE /api/schedules/:id` | owner or Admin | – | 204 | `handle.delete` |
| `GET /api/workspace/tree` | User | `path?` | entries | fs (read-only) |
| `GET /api/workspace/file` | User | `path` | file stream (size limit 20 MB, content-type sniffed) | fs |
| `GET /api/workspace/commits` | User | `path?, limit?` | commits with parsed trailers | git log |
| `POST /api/workspace/uploads` | User | multipart (max 50 MB/file, 10 files) | `{ taskId }` | write to staging, start `taskWorkflow(type:'upload')` |
| `GET /api/audit/search` | User | `q, from, to` | tasks + commits | visibility query + git log grep |
| `POST /api/admin/agent/force-release` | Admin | `{ taskId }` | 204 | signal `forceRelease` |
| `POST /codec/decode`, `/codec/encode` | Admin | Temporal codec format | | §7.10 |

### 9.3 SSE specifics (App Service)

- Send a comment line (`: keepalive`) every **20 s**. App Service closes idle requests after roughly 230 s.
- Set `Cache-Control: no-cache`, `X-Accel-Buffering: no`; disable compression for this route.
- Events are sanitized: tool name, status, short title, file paths, text deltas of assistant messages. No raw tool output beyond 2 KB per event.
- If the task is not currently running a step, send `event: idle` and keep the connection open.

### 9.4 Application audit log

Write-only JSON lines to `/home/artifacts/audit-log/<yyyy-mm>.jsonl` for actions that are not Temporal workflow events (schedule edits, force-release, file downloads optional). Each line: `{ at, by, action, target, details }`.

---

## 10. Activity timeline (history → timeline mapping)

Implemented in `apps/server/src/timeline/mapHistory.ts`. Pure function: `(history, decodedPayloads) → Timeline`. Unit-tested against recorded histories.

### 10.1 Output schema

```ts
interface Timeline {
  lanes: Array<{ id: string; label: string; kind: 'task' | 'agent' | 'schedule' }>;
  items: TimelineItem[];
}
type TimelineItem =
  | { type: 'span'; lane: string; id: string; category: 'plan'|'run'|'fix'|'verify'|'finalize'|'upload'|'maintenance'|'wait-lock'|'wait-approval';
      label: string; start: string; end?: string; status: 'running'|'ok'|'failed'|'retried';
      attempt?: number; details?: { summary?: string; commit?: string; tokens?: number; artifacts?: string[] } }
  | { type: 'marker'; lane: string; id: string; category: 'requested'|'approved'|'rejected'|'revise'|'comment'|'cancelled'|'reminder'|'completed'|'failed';
      label: string; at: string; by?: { upn: string; name: string }; text?: string };
```

### 10.2 Mapping rules

| History event(s) | Timeline item |
|---|---|
| `WorkflowExecutionStarted` | marker `requested` (by = input.requestedBy or schedule owner) |
| `ActivityTaskScheduled` + `Started` + `Completed/Failed/TimedOut` for `runAgentStep` | span with category from input `kind`; `retried` if attempt > 1 |
| same for `verify`, `finalizeTask`, `applyUpload`, maintenance activities | span with corresponding category |
| signal `acquire` sent (`SignalExternalWorkflowExecutionInitiated`) → signal `granted` received | span `wait-lock` (only shown if > 5 s) |
| status upsert to `awaiting_approval` → `decide` update completed | span `wait-approval` |
| `WorkflowExecutionUpdateAccepted/Completed` for `decide` | marker `approved`/`rejected`/`revise` with `by` and comment |
| update `comment` | marker `comment` |
| `TimerFired` for reminder | marker `reminder` |
| `WorkflowExecutionCompleted/Failed/Canceled/Terminated` | marker `completed`/`failed`/`cancelled` |

- Use the activity summary (or `summary` input field) as `label`.
- Running workflows: open spans have no `end`; UI polls every 5 s while a task is running (plus SSE for detail).
- Closed workflows: cache mapped timelines in an LRU (500 entries). After retention expiry, serve from the audit export (§7.9).

---

## 11. UI specification (apps/web)

Stack: React 19, Vite, TypeScript, React Router, TanStack Query, a component library of choice (e.g. Fluent UI React v9 to match the Microsoft environment). Timeline rendered with a custom SVG component (no heavy dependency required).

### 11.1 Pages

1. **Home / Tasks:** "New task" form (title, instructions, type, approval policy default `plan`), task list with filters (status, requested by me, type), status chips, agent status banner (idle / working on X / N waiting).
2. **Task detail:**
   - header: title, status, requester, trigger, token usage bar (used / budget)
   - **Approval panel** when `awaiting_approval`: rendered plan (markdown from `.agent/plans/<taskId>.md`), buttons Approve / Request changes / Reject, comment box
   - **Live panel** (SSE) while running: streaming assistant text, tool calls as compact rows
   - **Timeline** for this task (§10)
   - steps list with summaries, links to commits and artifacts; diff viewer for each step commit
   - notes/comments thread
3. **Activity timeline (global):** swimlanes per task over a selectable range (today / 7 days / custom), agent lock lane on top, click-through to task detail. Legend: plan, run, verify, fix, wait (dashed), approval marker.
4. **Schedules:** list, create/edit (calendar picker: daily/weekly/monthly/custom cron, timezone fixed Europe/Berlin), pause/resume, next run times, recent runs (from visibility query `ScheduleId = …`).
5. **Workspace:** file tree, file preview (markdown, CSV table, text, images, PDF via browser), file history (commits with trailers → "requested by / approved by / task" links), upload.
6. **Audit:** search by person, date range, path, free text; results combine tasks and commits.

### 11.2 UX rules

- Every place that shows a change shows **who requested it, who approved it, when, and the task link**.
- Approval actions require a confirmation dialog; rejection requires a comment.
- Show the server-side identity ("Signed in as …") in the header.
- Accessible (keyboard, contrast), responsive down to tablet width.
- Internationalization-ready (English default; German strings may be added later).

---

## 12. AI gateway integration

**Assumptions (confirm with the platform team before M2; record in `docs/decisions.md`):**
1. The platform exposes an **OpenAI-compatible** chat completions endpoint with tool calling, streaming, and usage reporting. If not, configure the matching AI SDK provider package in the harness config instead.
2. Authentication via API key (header) per application. Key stored in Key Vault.
3. The platform enforces model governance and cost tracking. We additionally enforce **per-task token budgets** in the workflow.

Implementation:
- Provider block in harness config (§6.2). Model ids configurable via `AI_GATEWAY_MODEL`; optional cheaper model for summaries if the harness supports a "small model" setting ⚠ VERIFY.
- Token usage is read from harness message metadata (§6.3) and accumulated in `TaskState.usage`.
- Network: AI gateway endpoint reachable from the App Service (via VNet route-all if private; add NSG/UDR rules as required).
- Failure handling: HTTP 429/5xx from the provider surface as harness provider errors → `runAgentStep` throws retryable → Temporal retries with backoff.

---

## 13. Security requirements

| Area | Requirement |
|---|---|
| Authentication | EasyAuth v2 with Microsoft identity provider, **require authentication**, unauthenticated action = redirect (UI) / 401 (API, via `excludedPaths` handling or `x-ms-*` check). Single-tenant app registration. |
| Authorization | Entra **app roles** `Agent.User`, `Agent.Approver`, `Agent.Admin`, assigned via groups. "Assignment required" enabled on the enterprise app. |
| Token store | Enabled (needed only if the API calls downstream APIs on behalf of users; not required in v1). |
| Harness isolation | Bound to 127.0.0.1, random per-boot password, permissions allowlist, no commit rights, no web access. |
| Secrets | Key Vault references only; nothing secret in the workspace or in Temporal payloads. The harness never sees Temporal credentials. |
| Temporal transport | Private VNet only (no public endpoint) **and** mTLS between workers/clients and the frontend. Certificates in Key Vault; rotation documented in runbook. |
| Payloads | Encrypted with codec (§7.10). |
| Web UI (Temporal) | Internal ingress only, protected with Entra auth (Container Apps built-in auth), admin group only. |
| PostgreSQL | Private access (VNet), Entra auth or strong password in Key Vault, TLS required. |
| App Service | HTTPS only, TLS ≥ 1.2, FTP/FTPS disabled, SCM basic auth disabled, `vnetRouteAllEnabled = true`. |
| Supply chain | Pin all versions (npm, harness, Temporal images). Lockfile committed. Dependabot/Renovate with manual approval. Container image scanned in CI. |
| Input limits | Size limits on instructions, uploads, comments; rate limit task creation (e.g. 30 tasks/user/hour). |
| Logging | No prompt contents or file contents in App Insights logs, only ids, sizes, durations, token counts. |

---

## 14. Infrastructure (Bicep, `infra/bicep`)

One resource group per environment (`rg-agent-dev`, `rg-agent-prod`), region **Germany West Central** (confirm). Parameterize names.

### 14.1 Network

- VNet `10.40.0.0/16`:
  - `snet-app` `/26`, delegated to `Microsoft.Web/serverFarms` (App Service VNet integration)
  - `snet-aca` `/23` (Container Apps environment, workload-profile environment)
  - `snet-pg` `/28`, delegated to `Microsoft.DBforPostgreSQL/flexibleServers`
  - `snet-pe` `/27` for private endpoints (Key Vault, Storage for backups)
- Private DNS zones: PostgreSQL, Key Vault, Blob, Container Apps environment default domain.

### 14.2 App Service

- **Plan:** Linux, SKU **B2**, capacity 1. Autoscale: none.
- **Web App:** custom container from ACR (managed identity pull), `alwaysOn: true`, `http20Enabled: true`, `healthCheckPath: '/health'`, `httpsOnly: true`, `ftpsState: 'Disabled'`, `minTlsVersion: '1.2'`, VNet integration to `snet-app`, `vnetRouteAllEnabled: true`.
- App Settings: §4, plus `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` (mounts persistent `/home` for custom containers), `WEBSITES_PORT=8080`, `WEBSITES_CONTAINER_START_TIME_LIMIT=600`.
- EasyAuth v2 (`authsettingsV2`): Microsoft provider, require auth, redirect for unauthenticated browser requests, allowed audiences = app registration.
- System-assigned managed identity with: `AcrPull` on ACR, `Key Vault Secrets User`, `Storage Blob Data Contributor` on the backup container.
- **Note:** Basic tier has no deployment slots. Deploys restart the single instance; this is handled by Temporal retries and Git checkpoints.

### 14.3 Temporal (self-hosted) on Azure Container Apps

Default choice: **Azure Container Apps** (internal environment) for low operational overhead. Alternative: AKS with the official Temporal Helm chart, if the organization already operates AKS. Record the choice as an ADR.

- Container Apps **environment**: internal (no public IP), VNet `snet-aca`.
- **Schema job** (Container Apps Job, manual trigger): image `temporalio/admin-tools:<pinned>`, runs `temporal-sql-tool` to create/update the `temporal` and `temporal_visibility` schemas on PostgreSQL ⚠ VERIFY current tool name/flags and supported PostgreSQL version.
- **Temporal server app:** image `temporalio/server:<pinned>` running all services (frontend, history, matching, worker) in one replica for v1. Config via environment-templated config file (`infra/temporal/config_template.yaml`) mounted as a secret volume: PostgreSQL persistence + SQL visibility, `numHistoryShards: 512` (cannot be changed later — choose deliberately), TLS/mTLS for frontend with server cert and client CA. Ingress: **TCP**, internal, port 7233 (TCP ingress requires a VNet-integrated environment) ⚠ VERIFY. Min/max replicas 1. CPU 1, memory 2 GiB to start.
- **Temporal Web UI app:** image `temporalio/ui:<pinned>`, internal HTTP ingress, Container Apps auth with Entra (admin group), `TEMPORAL_ADDRESS` to the server app, codec endpoint pointing to the API (§7.10).
- Do **not** use the `auto-setup` image in production.

### 14.4 PostgreSQL

- Azure Database for PostgreSQL **Flexible Server**, version per Temporal compatibility ⚠ VERIFY, tier Burstable `B2s` (start), 32 GiB storage with auto-grow, private access in `snet-pg`, backup retention 14 days, HA disabled for v1.
- Databases: `temporal`, `temporal_visibility`. Dedicated login with least privilege.

### 14.5 Bootstrap script (`infra/temporal/bootstrap.sh`)

Run once per environment from the admin-tools job (or a CI job in the VNet):
```
temporal operator namespace create --namespace agent-prod --retention 90d
temporal operator search-attribute create --namespace agent-prod \
  --name AgentId --type Keyword --name RequestedBy --type Keyword \
  --name TaskType --type Keyword --name TaskStatus --type Keyword \
  --name TaskTitle --type Text --name Trigger --type Keyword \
  --name ScheduleId --type Keyword --name ApprovedBy --type KeywordList
```
⚠ VERIFY CLI syntax for multiple attributes in the pinned CLI version; split into separate calls if needed. Script MUST be idempotent (ignore "already exists").

### 14.6 Other resources

- Azure Container Registry (Basic), admin user disabled.
- Key Vault (RBAC mode, private endpoint, purge protection).
- Storage account for workspace backups (private endpoint, immutable policy optional, lifecycle rule 35 days).
- Log Analytics + Application Insights (workspace-based). Container Apps logs → same workspace.

---

## 15. Local development

`docker-compose.dev.yml` + scripts:
- Temporal: `temporal server start-dev --namespace agent-dev --db-filename .local/temporal.db` (Temporal CLI dev server) and run the search attribute bootstrap against it.
- Harness: installed locally (`npm i -g opencode-ai@<pinned>`) or via the dev container. `HOME_ROOT=./.local/home`.
- Server: `pnpm dev` (tsx watch) with `NODE_ENV=development`, `DEV_FAKE_USER=anna@example.com`, `DEV_FAKE_ROLES=Agent.User,Agent.Approver`.
- Web: `pnpm --filter web dev` with proxy to the server.
- Model provider: point `AI_GATEWAY_BASE_URL` to the AI gateway dev endpoint, or to a mock OpenAI-compatible server (`apps/server/test/mock-llm`) that returns scripted responses for tests.
- `pnpm reset:local` wipes `.local/` (temporal db + home).

---

## 16. Testing strategy

### 16.1 Unit tests (Vitest)

- `mapHistory` with fixture histories (normal, retries, rejection, cancellation, budget exceeded).
- Identity middleware (valid/invalid principals, roles).
- Path safety (`resolveWorkspacePath`) including symlink escape attempts.
- Git commit/trailer formatting and parsing.
- Harness client wrapper with a fake HTTP server.

### 16.2 Workflow tests (`@temporalio/testing`)

Use `TestWorkflowEnvironment.createTimeSkipping()` with mocked activities:
- Happy path: plan → approve → run → verify ok → completed; assert the status sequence and search attribute upserts.
- Two concurrent tasks: lock serialization; the second task's plan runs while the first waits for approval.
- Approval reminder after 4 h, expiry after 7 d.
- Revise loop (max 3).
- Verify fails → fix rounds → failed after `TASK_MAX_FIX_ROUNDS`.
- Budget exceeded mid-task.
- Cancellation during step: `release` is still signalled (lock not leaked).
- AgentWorkflow stale-lock recovery when the holder workflow is terminated.
- AgentWorkflow `continueAsNew` preserves the queue.

**Replay tests:** store histories of representative executions in `packages/workflows/test/histories/*.json` and run `Worker.runReplayHistories` in CI for every change to `packages/workflows`. CI MUST fail on non-determinism.

### 16.3 Activity / integration tests

- `runAgentStep` against a real harness with the mock LLM: idempotency (second call with same `stepId` returns stored result, no new commit), reset on dirty tree, abort on cancellation, heartbeat emission.
- `verify` with sample verification scripts.

### 16.4 End-to-end (staging environment)

Scripted scenario mirroring the use case (§19): Anna submits, plan generated, Ben submits second task, Anna approves, report produced, schedule created, schedule triggered manually (`trigger` via API), timeline shows all items, git log shows trailers, audit export exists.

---

## 17. CI/CD (GitHub Actions)

1. **PR pipeline:** install (pnpm, frozen lockfile) → lint (eslint, `no-restricted-imports` to enforce workflow sandbox rules) → typecheck → unit tests → workflow tests → **replay tests** → build web + server + workflow bundle → Docker build → image scan (Trivy).
2. **Main pipeline:** PR steps + push image to ACR (tag = git SHA) → deploy to **dev** → smoke test (`/health`, create and complete a scripted task with mock LLM in dev namespace).
3. **Release to prod (manual approval):**
   - Pre-deploy check: call `/api/agent/status` with a deploy identity. If a step is running, wait up to 15 min for the lock to be free (configurable), then proceed anyway (retries make it safe; waiting just avoids wasted tokens).
   - Update the Web App container image to the SHA → App Service restarts the container.
   - Post-deploy smoke test.
4. Infrastructure: separate workflow running `az deployment group what-if` on PR and `create` on approval.
5. Workflow code changes that are not replay-compatible MUST use `patched()`; the replay test enforces this.

---

## 18. Observability and operations

### 18.1 Telemetry

- OpenTelemetry Node SDK → Application Insights. Temporal SDK interceptors/plugins for OpenTelemetry ⚠ VERIFY package (`@temporalio/interceptors-opentelemetry`), so that workflow/activity spans correlate with HTTP requests.
- Custom metrics: `agent.task.started/completed/failed` (by type), `agent.step.duration`, `agent.tokens.used` (by task type, model), `agent.lock.wait.duration`, `agent.harness.restarts`.
- Log fields: `taskId`, `workflowId`, `runId`, `stepId`, `user.upn` (hashed in logs if required by data protection).

### 18.2 Alerts

- `/health` degraded > 5 min.
- Task failure rate > 20 % over 1 h.
- Lock held > 90 min.
- Temporal frontend unreachable from the app > 2 min.
- PostgreSQL storage > 80 %.
- Daily token usage > configured threshold.

### 18.3 Runbook (`docs/runbook.md`) MUST cover

- Restart app / harness; reading harness logs.
- Stuck lock: inspect `AgentWorkflow` status, terminate the dead task, use force-release.
- Failed task: inspect timeline + transcript artifacts; re-run as a new task referencing the old one.
- Restore workspace from a backup bundle.
- Rotate mTLS certificates, codec key (add new key id, keep old for decode), AI gateway API key.
- Temporal upgrade procedure (schema job first, then server image), PostgreSQL maintenance.
- How to read encrypted histories in Temporal Web UI (codec server).

---

## 19. Reference scenario (acceptance narrative)

Use this scenario for the E2E test and the demo:

1. **09:12** Anna (`Agent.User`) submits: "Evaluate the offers in `/offers/2026-11` and create a comparison matrix with a recommendation." Type `report`, approval `plan`.
2. Agent plans → `.agent/plans/task-A.md`, commit with trailers; status `awaiting_approval`; Anna is notified.
3. **09:20** Ben submits a change task ("Add new contacts from `contacts.csv` to the supplier list", approval `none`). It acquires the lock immediately (Anna's task holds no lock while waiting) and completes.
4. **10:05** Anna approves with comment "Weight delivery times higher." The update is recorded with her identity.
5. Agent runs, verify script flags a missing offer, one fix round, verify passes, finalize, audit export, notify Anna.
6. Anna creates schedule "Monthly offer evaluation", 1st of month 07:00 Europe/Berlin, approval `deviation`.
7. Admin triggers the schedule manually; the task runs without approval because no deviations are flagged.
8. Clara opens the Audit page, searches for the supplier name and finds: Anna's request, Anna's approval comment, the commits and diffs, the timeline, all linked by task id.

---

## 20. Milestones and acceptance criteria

| # | Milestone | Acceptance criteria |
|---|---|---|
| **M0** | Repo + local dev | Monorepo builds; lint/typecheck pass; local Temporal dev server, harness and server start with one command; `/health` OK. |
| **M1** | Harness integration | Harness supervised; client wrapper implemented; single prompt end-to-end against the mock LLM and against the AI gateway dev endpoint; events received; abort works; SMB/data-dir test (§6.6) executed on an App Service dev instance and result recorded. |
| **M2** | Core workflows | `AgentWorkflow` + `TaskWorkflow` + all activities; workflow tests (§16.2) green; replay tests in CI; idempotency tests green; git trailers correct. |
| **M3** | API + identity | All endpoints of §9.2 except timeline/global timeline; EasyAuth middleware with roles; SSE with keepalive; path safety tests. |
| **M4** | UI v1 | Tasks, task detail with approval + live panel, workspace browser, schedules. |
| **M5** | Timeline + audit | `mapHistory` with fixtures; task and global timeline views; audit export; audit search. |
| **M6** | Infrastructure | Bicep deploys dev environment from scratch: VNet, App Service B2, ACR, Key Vault, PostgreSQL, Temporal on Container Apps (mTLS, internal), Web UI with auth, backups. Bootstrap script idempotent. |
| **M7** | Hardening | Payload codec + codec server; OpenTelemetry; alerts; runbook; rate limits; image scanning; system schedules (gc, backup, cleanup) running. |
| **M8** | Prod go-live | E2E scenario (§19) passes on staging/prod; restart-during-step test (kill container mid-step → task resumes and completes without duplicate commits); backup restore rehearsal done. |

---

## 21. Open questions (resolve and record in `docs/decisions.md`)

1. AI gateway: protocol (OpenAI-compatible?), model ids, rate limits, whether usage/cost is returned per request, network reachability (public/private).
2. Container Apps vs AKS for Temporal (default: Container Apps).
3. Who may approve: any `Agent.Approver`, or the requester only, or both (default: both)?
4. Notification channel: Teams webhook, Graph API mail, or both?
5. Workspace size expectations (App Service `/home` quota on B2; large binaries should not go into Git, use Git LFS-free conventions or a separate blob folder).
6. Data protection: retention of transcripts (default 180 days), hashing of user identifiers in telemetry.
7. Should the harness config live outside the workspace (preferred) — depends on the pinned harness's config lookup (§5.2 step 4).
