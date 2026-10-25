# ADR-0015: Rejecting a deviation reverts the task's run/fix commits

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §7.5.1 step 4 (deviation approval, behaviour after the decision not specified)

## Decision

For `approval: 'deviation'`, when verification passes but reports anomalies, the task waits for a decision:

- **approve** → finalize,
- **revise** (comment) → one more `fix` step with the comment, then verify again (counts against `maxFixRounds`),
- **reject** → `finalizeTask({ revert: true })`: the activity reverts all commits of this task whose `Step-Id` is a
  `run` or `fix` step (newest first, `git revert --no-commit`, one revert commit together with the audit export).
  Plan and summaries stay (they document what was proposed). If the revert conflicts (other tasks changed the same
  files meanwhile), it is aborted and the conflict is recorded in the audit export (`revertError`).

## Consequences

- Rejected results do not silently remain in the shared data set.
