# ADR-0012: Task ids of scheduled runs and file-system-safe paths

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §7.2, §7.5 (`taskId == workflowId`), §8.1

## Context

Schedules start workflows with the configured workflow id plus an RFC 3339 timestamp suffix
(`task-sched-max-monthly-2026-11-01T06:00:00Z`). Task inputs of schedules are static, so `TaskInput.taskId` cannot
contain the run's id. Colons are invalid in Windows file names, and the workspace is a Git repository people may clone.

## Decision

- The workflow always uses `workflowInfo().workflowId` as task id; `TaskInput.taskId` is informational.
- Task id pattern: `^task-[A-Za-z0-9:._-]{3,120}$`.
- Every path derived from a task or step id uses `stepFileName()` (`:` `/` `\` → `_`):
  `.agent/plans/<id>.md`, `.agent/summaries/<step>.md`, `.agent/steps/<step>.json`, `.agent/audit/yyyy/mm/<id>.json`,
  artifacts `<id>/<step>-transcript.json`. Step ids themselves keep the spec format `<taskId>:<kind>:<n>` (Git trailer
  `Step-Id`).
