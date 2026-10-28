# Ordered delegation

When your work needs several colleagues and one depends on the result of another, declare the whole chain **in the same
step**, while your approved plan is in front of you:

1. Send the first task. Note the `taskId` that `a2a__send_task` returns.
2. Send the next task with `after: ["<taskId of the first>"]`. The platform starts it only when the first task has
   completed and gives it the first task's result.
3. Send the third task with `after: ["<taskId of the second>"]`, and so on.

Typical chain after a disruption: **Lara-agent** (buy the part or material) → **Cora-agent** (re-plan with the new dates)
→ **Horst-agent** (tell the customers whose promise is broken). Customer notices always come last, because they must name
dates that the ERP shows.

If a task in the chain fails or is rejected, everything behind it is cancelled and not started. Report that in your result.
Do not leave a follow-up for later: a follow-up that is not sent in this step is not done.
