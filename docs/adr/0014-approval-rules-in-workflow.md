# ADR-0014: Approval rules enforced by update validators (and the API)

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §7.5 messages, §9.2, §21 open question 3 (who may approve — default "both")

## Decision

- `TaskInput.settings.approverPolicy` (`approver-or-requester` default, `approver-only`, `requester-only`) is fixed
  per task at start (from `APPROVER_POLICY`), so it is deterministic and visible in the history.
- The `decide` **update validator** enforces: task is `awaiting_approval`; comment required for reject/revise;
  max. revisions (`TASK_MAX_REVISIONS`, default 3); caller is approver or requester according to the policy.
  The API checks the same before calling (better error messages, defence in depth).
- The caller identity in `by` is the server-side principal **including roles**, so the workflow can evaluate roles.
- Rejected updates leave **no trace in the history** (validators run before acceptance) — only accepted decisions are
  audited, which is the desired behaviour.
- For scheduled tasks the "requester" is the schedule owner.
