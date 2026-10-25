# ADR-0030: Chat with the agent about a task

- **Status:** Accepted
- **Date:** 2026-10-25
- **Extends:** [ADR-0028](0028-task-conversation.md)

## Context

The task conversation (ADR-0028) showed the history, and its input box only added a comment to the workflow. People
expected an answer, e.g. "What is shown in the picture?" on an upload. On finished tasks the box failed, because the
workflow is closed.

## Decision

- The input box of the conversation is a **chat with the agent**. Questions work on running, waiting and finished
  tasks, including tasks beyond Temporal retention: the state then comes from the audit export.
- **Answering:** the agent calls its model directly through LiteLLM with its own virtual key, so the cost counts
  towards its spend limit (ADR-0029).
- **Context of the answer:**
  - the request, the step reports, decisions with comments, colleagues' answers and the result;
  - the task's files:
    - plan and result files and every workspace file a step changed;
    - text formats as text (≤ 40 KB each, ≤ 150 KB in total);
    - PNG, JPEG, WebP and GIF as **images** (≤ 3, ≤ 5 MB each), so vision models can describe them;
  - workspace files named in the question;
  - the last 20 chat messages.
- **Read-only:** the chat never changes the workspace and does not use the workspace lock. If a person wants
  changes, the agent points to *Request changes* or a new task. Decisions stay explicit buttons (ADR-0014).
- **Storage and audit:**
  - Messages are stored per task in `ARTIFACTS_DIR/chat/<taskId>.jsonl`, with model, tokens, cost and the files used.
  - Every question is written to the app audit log (`task.chat`).
  - The limit is 30 questions per person per 10 minutes.
- **Attachments:** the **+** button attaches files to the next message. They are shown as a preview (thumbnail for
  pictures, name, size) and can be removed one by one or all at once. Nothing is uploaded before sending: on submit, the
  remaining files are uploaded as one upload task (an audited commit authored by the person). After the commit the
  question is sent with the file paths, so the agent reads them. Up to 10 files, 50 MB each.
- **Guards:** questions are refused with a clear message when no AI model is available or the spend limit is reached.

## Consequences

- People can explore results ("why this supplier?", "summarise the table") without starting work, which is cheap:
  a typical answer costs well below one cent with gpt-5.4-mini.
- Chat answers are not part of the Git history; they are in the chat store and the audit log.
- The answer is only as good as the context limits; large binary formats (PDF, Excel) are listed by name but not
  read in the chat. The file preview (ADR-0027) shows them.
