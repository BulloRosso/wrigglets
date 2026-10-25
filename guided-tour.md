# Guided tour: working with an AI colleague

This tour starts with **what the people in a team see and do**, which is the actual product. It then shows how a
platform admin sets up a colleague, how colleagues work together, and how the admin stays in control.

All screenshots come from a real run on Docker Desktop. The run uses the scripted mock model, so the texts the
colleague writes are placeholders.

> **Before you start:** run `node scripts/stack.mjs up` (see [docs/getting-started.md](docs/getting-started.md)).
> The script prints the admin login and the password of the demo users Anna, Ben and Clara. For portraits, set
> `OPENAI_API_KEY` in your environment before starting the stack.

| Who | Role in the tour | Signs in at |
|---|---|---|
| Anna (`anna@example.com`) | asks Max for work and decides on his plans | agent Max http://localhost:8101 |
| Ben, Clara | colleagues with access to Max; Ben may approve | agent Max |
| Platform admin (`admin@example.local`) | creates and configures agents | admin console http://localhost:8080 |
| Max, Lara | AI colleagues; Max may delegate to Lara | — |

---

## Part 1 — What the users see

Everybody signs in through the platform's sign-in page. What a person can do comes from their roles for this agent.

![Sign-in page](docs/images/tour/01-sign-in.png)

The agent UI has five menu items. Max's portrait in the top left shows his mood: happy when idle, in doubt while he
waits for a decision, fearful when something went wrong.

| Menu item | What it is for |
|---|---|
| [Tasks](#tasks) | ask Max for work, follow it, decide on plans |
| [Activity timeline](#activity-timeline) | what Max did, for whom and when |
| [Schedules](#schedules) | recurring and future work |
| [Workspace](#workspace) | the shared files, with a preview for many formats |
| [Audit](#audit) | who requested, approved or changed what |

### Tasks

The task list shows every task with its status, who requested it and who approved it. The banner on top shows whether
Max is busy and how many tasks wait for the workspace.

![Task list with status banner](docs/images/tour/u01-tasks.png)

Under **New task**, Anna:

1. Describes what she needs (Markdown is fine).
2. Picks a type (*Report* produces a document).
3. Picks an approval mode. With **Approve plan first**, Max writes a plan and waits before he changes anything.

![New task form](docs/images/tour/06-new-task.png)

#### The conversation: one history per task

Each task has a **Conversation**: a Markdown chat that collects everything that happened in the task.

- **Anna's side:** her request, every decision with its comment, and comments.
- **Max's side:** what he reported after each step, answers from colleagues, and the result with its files.

Clicking a file opens the preview. A comment written in the box at the bottom becomes part of the history and the
audit trail.

While Max waits, he says so in the conversation. The decision card above it offers **Approve**, **Request changes** and
**Reject**.

![Conversation while Max waits for a decision](docs/images/tour/u07-conversation.png)

#### Human in the loop: Max asks by e-mail

Nobody has to watch the UI. As soon as a plan waits for a decision, Max sends an e-mail to **everybody who has access
to him**, and sends another as a reminder later. The buttons in the mail lead straight into the decision dialog of
this task.

![Approval e-mail](docs/images/tour/u08-approval-mail.png)

Clicking **Approve** opens the agent UI, after sign-in if needed, with the confirmation dialog already open. Anna adds
a comment and confirms. Clicking the link alone never decides anything.

![Decision dialog opened from the e-mail](docs/images/tour/u09-decision-dialog.png)

Max continues. When he is done, the conversation shows the decision, his report and the result files.

![Conversation after the task completed](docs/images/tour/u10-conversation-done.png)

### Activity timeline

The timeline shows what Max worked on, as lanes per task: planning, running, waiting for approval, verifying. It is
reconstructed from the Temporal event history. Click a lane to open the task.

![Activity timeline](docs/images/tour/u02-timeline.png)

### Schedules

Recurring work, such as a monthly offer evaluation, is a schedule. Every run is a normal task with the schedule owner
as requester. Schedules can be paused or run once on demand, and each one has its own approval rule.

![Schedules](docs/images/tour/u03-schedules.png)

### Workspace

The workspace is Max's shared data set, a Git repository. It is read-only here: files change only through tasks and
uploads, so every change is traceable. **Upload** adds files as a task of its own.

The preview shows files directly in the browser:

| Format | Preview |
|---|---|
| Markdown | rendered, including tables and Mermaid diagrams; *Source* toggle |
| Mermaid (`.mmd`) | diagram |
| PDF | the browser's PDF viewer |
| Excel (`.xlsx`, `.xls`) | one tab per sheet, values only |
| CSV | table |
| PNG, JPEG | image |
| Text and code | monospace |

*History* lists the commits that touched the file.

![Markdown with a Mermaid diagram](docs/images/tour/u04-workspace-markdown.png)

![Excel workbook with two sheets](docs/images/tour/u05-workspace-excel.png)

### Audit

The audit search finds tasks and commits by text, person, path and period: who requested something, who approved it,
and what exactly changed. Tasks that are older than the Temporal retention come from their audit export.

![Audit search](docs/images/tour/u06-audit.png)

---

## Part 2 — The admin sets up a colleague

### Create the agent

In the admin console, go to **Agents → New agent** and enter:

- a display name, e.g. *Lara*;
- an agent id (permanent, used in URLs and workflow ids);
- an optional description.

**Create agent** then:

- registers an OIDC client for the agent;
- creates a workspace volume;
- starts the container (API, Temporal worker and Agent Harness).

Access is granted per agent under **Users & access**, or on the agent's *Access* tab.

![New agent dialog](docs/images/tour/02-create-agent.png)

### Give the colleague a face

On the agent's **Portrait** tab:

1. Describe the character.
2. Press **Generate portraits**.

The OpenAI image model turns the shared guiding image (left) into this colleague's portrait, in four moods. The whole
character, including the antennae, stays inside the frame. Use **Redo** to regenerate a single mood, or **Replace** to
change the guiding image for all agents.

![Portrait tab with four moods](docs/images/tour/a03-portraits.png)

### Allow collaboration and tools

Agents are **isolated** by default. On Max's **Collaboration** tab, add Lara under *May delegate to*. Max can now
hand over tasks to her; the reverse is not allowed. On the **Safety** tab, allow Max the company tools offered by the
MCP gateway. Max never sees the credentials of these systems: the gateway takes them from Key Vault.

![Collaboration tab: Max may delegate to Lara](docs/images/tour/04-collaboration.png)

---

## Part 3 — Colleagues working together

Anna asks Max for a supplier comparison and approves his plan.

![Plan waiting for approval](docs/images/tour/07-plan-approval.png)

Max works through the plan:

1. He calls company tools through the gateway.
2. He asks Lara for a delivery-reliability check.
3. He waits, without blocking his workspace.

![Max waiting for Lara](docs/images/tour/08-waiting-for-colleague.png)

At Lara, the request is an ordinary task, *delegated by agent max for Anna Becker*, with its own plan, approval and
audit trail.

![Delegated task at Lara](docs/images/tour/09-lara-delegated-task.png)

When Lara has finished, her answer appears in Max's conversation. Max integrates it and completes the task.

![Completed task with Lara's contribution](docs/images/tour/10-task-completed.png)

> **With the mock model:** the mock only calls tools or asks colleagues when the instructions say so explicitly, e.g.
> ``Call the tool `a2a__send_task` with `{"agentId":"lara","title":"…","instructions":"…"}`.``
> A real model decides on its own.

---

## Part 4 — Staying in control

### Mail outbox

Every e-mail agents send is listed in the admin console's **Mail outbox**, with its recipients, delivery status and an
HTML preview.

- With a mail API configured (`MAIL_API_URL`, which receives `POST { to[], subject, body }`), mails are delivered
  through it.
- Without one, they are only written to the outbox directory `mail_out`.

![Mail outbox in the admin console](docs/images/tour/a13-mail-outbox.png)

### Kill switch and safety rules

The **Safety & tools** page brings the safety controls together:

- the **kill switch** for each agent, and the red top-bar button for all agents at once;
- the automatic triggers;
- the A2A discovery sets;
- the MCP gateway's upstream systems;
- the Key Vault secrets they use.

Levels, from mild to strict:

| Level | Effect |
|---|---|
| **Tools off** | company tools and delegation are blocked |
| **Paused** | no work runs; an interrupted step resumes later |
| **Stopped** | running tasks are cancelled and the container stops |

![Safety & tools page with Max paused](docs/images/tour/11-safety-page.png)

When an agent is paused, its users see a banner: who paused it, why, and what that means.

![Max paused by the admin](docs/images/tour/12-agent-paused.png)

---

## Where to go next

- [docs/architecture.md](docs/architecture.md): how it works.
- [docs/adr/](docs/adr/README.md): why it is built this way, for example:
  - [ADR-0026](docs/adr/0026-human-in-the-loop-email.md) human in the loop by e-mail;
  - [ADR-0027](docs/adr/0027-workspace-file-preview.md) file preview;
  - [ADR-0028](docs/adr/0028-task-conversation.md) task conversation.
- [docs/azure.md](docs/azure.md): what this becomes on Azure.
- [docs/runbook.md](docs/runbook.md): operations, including the emergency stop.
