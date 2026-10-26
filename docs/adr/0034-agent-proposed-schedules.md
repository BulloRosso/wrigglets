# ADR-0034: Agents propose scheduled tasks, people approve them in the chat

- **Status:** Accepted
- **Date:** 2026-10-26
- **Extends:** [ADR-0030](0030-chat-with-the-agent.md), [ADR-0010](0010-schedule-history-in-audit-log.md)

## Context

A person asked the agent in the task chat to "repeat this every Wednesday and Saturday". The chat was read-only and
could only tell them to create a schedule by hand. The agent should be able to set this up, but an agent must not
create future, unattended work on its own.

## Decision

- The chat model gets **one tool**, `propose_schedule`. Its parameters are the schedule form
  (`createScheduleBody`: title, instructions, type, approval, calendar), so a proposal is exactly what the form accepts.
- A proposal is only a **chat message with `proposal.status = pending`**. It is validated with the same zod schema as
  `POST /schedules`; an invalid call is dropped and the agent asks back. **Nothing is created in Temporal.**
- The conversation shows a **card**: title, when (Europe/Berlin), type, approval policy and the complete instructions
  of every run, with *Approve & schedule* and *Reject*.
- `POST /api/tasks/:id/chat/:messageId/proposal` `{decision}` decides:
  - only the person whose question led to the proposal, or an admin, may decide (checked on the server);
  - **approving creates the schedule** through `createUserSchedule`, the same function `POST /schedules` uses; the
    approver becomes the owner, so scheduled runs, their approvals and e-mails belong to them;
  - a proposal can be decided once; deciding is serialised per chat file, so a double click creates one schedule.
- **Audit:** the proposal is part of the `task.chat` entry; approval writes `schedule.created` with `via: chat`,
  the task and the proposal id; rejection writes `schedule.proposal_rejected`.
- The model's own text can never claim a schedule exists: the system prompt says so, and the history it sees marks each
  proposal as pending, approved or rejected.

## Consequences

- Prompt injection through a task's files can at most produce a card that a person has to read and approve. The card
  shows the full instructions, so what is approved is what will run.
- Scheduled runs are non-interactive and have no user token for OBO (ADR-0032); the approver approves future runs
  without their own token.
- Proposals exist in the task chat only. Agents that work in task steps (opencode, MCP tools) cannot propose schedules
  yet; a gateway tool could write the same kind of pending proposal into the chat.
- No notification is sent for a pending proposal: the person is in the chat when it appears.
