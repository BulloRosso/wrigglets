# ADR-0028: Task conversation (chat history) derived from the workflow state

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Users want one readable history per task: what was asked, what the agent reported, who decided what (human in the
loop), what colleagues contributed, and the result. This information already exists in the `TaskWorkflow` state:
the request, step summaries, decisions with comments, notes, delegations, cancellation, suspension and the result.

## Decision

- The task page shows a **Conversation** card. It is a chat view **derived from the workflow state**, not a separate
  message store, so it can never disagree with the audit trail.
  - **People** (right side): the request (title and instructions), decisions with their comments (*Approved*,
    *Changes requested*, *Rejected*), comments and cancellation.
  - **The agent** (left side, with its portrait in the matching mood): the report after each step (plan, work done,
    fix), answers from colleagues (A2A), the result with its files, failure messages, and a "waiting for you" prompt
    while a decision is pending.
  - **System lines:** delegations and kill-switch pauses.
- All messages are **Markdown**, including tables and Mermaid diagrams. Files mentioned in agent messages open in the
  file preview (ADR-0027).
- New comments are sent with the existing `comment` workflow update. They become part of the history and the audit
  export.
- Decisions are not made by chat text; they stay explicit buttons with confirmation and are validated by update
  validators (ADR-0014). This keeps decisions unambiguous.

## Consequences

- Nothing new to store, retain or secure. The conversation of a task closed beyond Temporal retention comes from the
  audit export like the rest of the task page.
- The agent does not answer chat messages in real time. Comments are context for people; a change request is the way
  to make the agent revise its plan.
