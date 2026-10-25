# Runbook

Operational procedures (spec §18.3). Commands are for the local Docker stack; the Azure equivalent is noted where it
differs.

## Emergency stop (kill switch)

Use the kill switch when an agent misbehaves (unexpected tool use, cost spike, wrong data) — [ADR-0022](adr/0022-kill-switch.md).

1. Pick the level:
   - **Tools off**: company systems are touched wrongly. File work continues.
   - **Paused**: stop all work but keep every task. The running step is aborted and repeated later.
   - **Stopped**: the agent must not run at all. Running tasks are cancelled and the container stops.
2. Set it:
   - for **one agent**: Admin console → Agent → *Safety* tab, or *Safety & tools* page → *Change*;
   - for **all agents**: the red **Kill switch** button in the top bar.

   A reason is required; users see it in a banner.
3. Verify:
   - the agent UI shows the banner;
   - *Safety* tab → *Recent tool calls* shows `denied` for new calls;
   - for *paused*, the task shows `suspended` and the workspace lock has no holder.
4. Investigate:
   - gateway audit (`/data/audit/*.jsonl` in `cw-mcp-gateway`, tool and outcome only);
   - task timelines, harness logs.
5. Lift: choose **Normal**. For *stopped*, the container is started again. Automatic rules for that agent are snoozed
   for 60 minutes after a manual lift.

Automatic trips (safety rules) appear with `auto · <rule>` in the console. They are never lifted automatically.

**If the control plane is down:** the gateway stops all tool calls after 30 s on its own (fail-closed). To stop an
agent completely, run `docker stop cw-agent-<id>` (Azure: stop the Web App).

## Restart an agent / the harness

- Admin console → Agent → **Restart** (container restart) or **Redeploy** (re-create container from the registry
  entry, re-register the OIDC client). The workspace volume is kept. Running steps are retried by Temporal; Git
  checkpoints prevent duplicate commits (`Step-Id` trailer).
- The harness alone restarts automatically (back-off 1→30 s). `/health` shows `harness.state` and `restarts`; it
  turns *degraded* after 60 s down.
- Harness logs: agent logs lines with `"harness":true` (Admin console → Logs, filter `harness`).
- Azure: Web App restart; logs in Log Analytics (`AppServiceConsoleLogs`).

## Stuck workspace lock

1. Admin console → Agent → Overview → *Workspace lock* (holder, waiting) — or query `status` on `agent-<id>` in the
   Temporal Web UI.
2. If the holder workflow is closed, the lock is cleared automatically within 5 minutes (stale-lock check).
3. If the holder is running but hung: cancel the task (agent UI, *Cancel task*, requester or `Agent.Admin`) or
   terminate it in the Temporal Web UI.
4. Last resort: `POST /api/admin/agent/force-release {"taskId": "…"}` on the agent (role `Agent.Admin`), recorded in
   the application audit log and the lock-manager history.

## Failed task

- Task page: error, timeline (failed spans show the error), steps with summaries, commits and diffs.
- Transcripts: `/home/artifacts/<task>/<step>-transcript.json`; verification reports `verify-<n>.md`
  (`docker exec -u node cw-agent-<id> ls /home/artifacts/<task>`).
- Re-run as a **new task** referencing the old task id in the instructions.

## Restore the workspace from a backup

Backups: system schedule `sched-sys-<agent>-backup` (daily 02:40 Europe/Berlin) writes
`/home/backups/workspace-<agent>-<date>.bundle` (Azure: Blob container, 35 days).

```bash
docker exec -u node cw-agent-max sh -c 'ls -la /home/backups'
# stop the agent, then restore into a fresh clone:
docker stop cw-agent-max
docker run --rm -v cw-agent-max-home:/home coworking/agent:local sh -c \
  'cd /home && mv workspace workspace.broken && git clone backups/workspace-max-2026-10-25.bundle workspace && chown -R node:node workspace'
docker start cw-agent-max
```

Tasks finalized after the backup must be re-run; their audit exports are lost with the workspace unless recovered
from `workspace.broken`.

## Rotate an upstream credential

Admin console → *Safety & tools* → *Key Vault secrets* → **Rotate**. The gateway picks up the new value within 5 minutes
(cache), or immediately after `docker restart cw-mcp-gateway`. The Lowkey Vault emulator keeps data in memory: after a
restart of `cw-keyvault`, only the demo secret is re-seeded automatically (restart `cw-temporal`); set the others
again. Azure: rotate in Key Vault; nothing else changes.

## Rotate secrets

| Secret | Procedure |
|---|---|
| Payload codec key | Prepend a new key: `PAYLOAD_CODEC_KEYS=k2:<new>,k1:<old>`; `docker compose up -d` (control plane) and **Redeploy** every agent. Keep `k1` until all histories encrypted with it are past retention (90 days). |
| OAuth admin token | change `OAUTH_ADMIN_TOKEN` in `.env`, `docker compose up -d` (both containers). |
| Agent OIDC client secret / session secret | delete and re-create the agent, or edit `/data/admin/agents.json` and Redeploy (sessions are invalidated). Azure: Key Vault + app setting references. |
| AI gateway API key | `.env` / Key Vault → Redeploy agents. |
| mTLS certificates (Azure) | issue new client cert, store in Key Vault, restart Web Apps (Key Vault references refresh within 24 h or on restart); rotate server cert in the Temporal Container App; keep both CAs during rollover. |

## Temporal upgrade

Local: change `TEMPORAL_CLI_IMAGE` in `infra/docker/Dockerfile`, rebuild the control-plane image. The SQLite file is
migrated by the dev server. Azure: run the schema job (`temporal-sql-tool update-schema` for both databases) with the
new admin-tools image **first**, then roll the server image; then UI.

## Reading encrypted histories

Temporal Web UI (`:8233`) decrypts via the admin console's codec endpoint automatically. CLI: payloads appear as
`binary/encrypted`; use the agent's `/codec/decode` (Agent.Admin) or the audit export in the workspace, which
contains the decoded history.

## Reset the local environment

`node scripts/stack.mjs reset` removes agent containers and volumes, Temporal and OAuth data. Use `--env` to also
regenerate secrets.
