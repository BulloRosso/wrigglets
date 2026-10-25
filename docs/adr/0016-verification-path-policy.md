# ADR-0016: Verification — path policy per task type and plug-in scripts

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §7.6 `verify`

## Decision

Deterministic checks over the files changed by **this task's commits** (found via the `Task-Id` trailer, so commits
of other tasks made between steps are not attributed to it):

| Rule | Failure |
|---|---|
| Protected paths: `.git/`, `AGENTS.md`, `opencode.json(c)`, `.opencode/`, `.agent/audit/` | always |
| Plans/summaries/step records of **other** tasks | always |
| Task type `analysis` / `report`: changes outside `.agent/` and `reports/` | yes |
| Task type `change`: any other path | allowed |
| A summary file for every step | missing → failure |

Plug-in: `scripts/verify/<type>.py|.mjs|.js` in the workspace, run with `TASK_ID`, `TASK_TYPE`, `CHANGED_FILES`
(5 min timeout). Exit 0 → ok, stdout JSON (`[...]` or `{anomalies: [...]}`) = anomalies; exit ≠ 0 → failures
(stdout JSON or a generic message). Report: `artifacts/<task>/verify-<n>.md`.

If the harness forgets the summary file, `runAgentStep` writes it from the final answer (marked as generated), so the
summary rule catches only real problems.
