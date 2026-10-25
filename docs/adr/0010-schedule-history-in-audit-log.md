# ADR-0010: Schedule change history in the application audit log

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §7.7 ("history array in the schedule memo (last 50 changes) **and** an application audit log entry")

## Context

In Temporal TS SDK 1.24 `ScheduleUpdateOptions` is `Omit<ScheduleOptions, 'scheduleId' | 'memo'>`: the memo of a
schedule cannot be changed after creation (verified in the SDK types).

## Decision

- The schedule memo stores the immutable facts: `owner`, `createdBy`, `createdAt`, initial `calendar` (and `history: []`).
- Every change (created, updated, paused, resumed, triggered, deleted) is written to the **application audit log**
  (`/home/artifacts/audit-log/<yyyy-mm>.jsonl`) with the caller's identity; the schedules API returns the last 50
  entries per schedule as `history`. The schedule's `note` holds the latest change note.

## Consequences

- The UI shows the same history the spec intended; the source of truth is the audit log.
- If the calendar is changed, `memo.calendar` shows the original one; the current spec is read from the schedule
  description (and the latest `updated` audit entry).
