# ADR-0037: Optional Signals: proactive follow-up on observations and deadlines

- **Status:** Accepted
- **Date:** 2026-11-13
- **Extends:** [ADR-0021](0021-mcp-gateway.md), [ADR-0026](0026-human-in-the-loop-email.md), [ADR-0034](0034-agent-proposed-schedules.md)

## Context

Agents work only when a person or a schedule gives them a task. Much of the work that piles up in a company, though, is
open loops that nobody owns: the hotel invoice that never arrived, the order without a confirmation, the customer who
promised an answer by Friday. A fixed list of if-then automations does not cover these, because the rule depends on what
a message *means*. What we want is an agent that notices that there is a task.

The platform had no way in for information: nothing received mail, messages or events. It also had no durable memory
for "something should happen by date X".

## Decision

Signals is an **optional module** made of five parts.

- **Observation → event → expectation.** An observation (a mail, an MQTT message, an HTTP post, something an agent
  reports) is interpreted by the **agent's own model** in the context of its role: its AGENTS.md plus a short **Signals
  brief** that states role, goals and limits, not process rules. The answer is structured output: **0..n events** (zero
  is valid), the open **expectations it fulfils** (with a confidence), and **0..5 new expectations**. Each new expectation
  has a title, a reason, a hint for recognising its fulfilment, a due date, and an action for when it is overdue.
- **One Temporal workflow per expectation.**
  - `expectationWorkflow` runs in the agent's namespace and task queue, next to its tasks. It waits until it is
    fulfilled, dismissed or due (`condition(…, dueAt)`, as the approval wait does).
  - When it is due, it raises a **signal**, then stays open for a late fulfilment until a grace period ends (default 30
    days).
  - Updates `editExpectation`, `fulfillExpectation` and `dismissExpectation`. A new due date re-arms the timer, also
    after a signal ("snooze").
  - Search attributes `SignalState`, `SignalDue` and `SignalSource`.
  - `observationWorkflow`, one per observation, does the interpretation, fulfils matches above the threshold, and starts
    the expectation workflows as abandoned children. Its id is derived from the source and Message-ID (or a body hash),
    so an observation delivered twice is processed once.
- **A signal never acts outside the platform.** The action is set per expectation, with a per-agent default.
  - `notify`: inbox notice and mail through the existing human-in-the-loop path (`/internal/agents/:id/notify`, new kind
    `signal_raised`).
  - `propose_task`: a follow-up task with `trigger: signal` and `approval: plan`, forced server-side. A person approves
    its plan before anything runs. The exfiltration guard and the allow-list apply as for every task.
  - While the agent is paused or stopped, raising waits (the activity is retried).
- **Signals hub** (`apps/signals-hub`, compose overlay `docker-compose.signals.yml`): the connectors and an MCP upstream.
  - **HTTP sources:** a bearer token per source. The control plane stores only its SHA-256, and the source decides the
    agent.
  - **IMAP accounts:** poll plus reaction to new-mail notifications; mails are marked as seen or moved afterwards.
  - **MQTT brokers:** topic filters per agent, debounce, hourly limit and payload cap.
  - Connector passwords are Key Vault references.
  - The hub writes every observation to a **durable outbox** first. It forwards to the control plane, which hands the
    observation to the agent with the agent's control-plane token; the hub never reaches agents directly. A paused or
    stopped agent, or one that cannot be reached, leaves the observation in the outbox, retried with backoff for up to 7
    days.
  - The MCP tools `signals__observe`, `signals__list_expectations` and `signals__resolve_expectation` take the caller
    from the gateway (`_agent`, `_task`), so an agent only reports for itself and only sees and resolves its own
    expectations.
- **Settings live in the control plane**, as the guard configuration does (`DATA_DIR/admin/signals.json`).
  - Per agent: on/off, brief, owner (the requester of follow-up tasks), default action, fulfilment threshold,
    observations per hour, grace days, model.
  - Agents fetch their settings and cache them for 20 s, so switching Signals on or off needs no redeploy.
  - The hub polls the connector configuration.
  - Without `SIGNALS_HUB_URL` and `SIGNALS_HUB_TOKEN` every Signals route answers 404, agents treat Signals as off, and
    the UIs hide it.
- **People stay in charge and teach it.** The agent UI shows the open loops, the observations (including the ones with
  no events) and a playground, where a text is interpreted and the result reviewed, edited and committed. People
  change due dates and actions, mark expectations fulfilled, or dismiss them with a reason. The last corrections are
  given to the interpreter as examples.

## Alternatives

- **A JSON store plus a timer loop in the hub.** Simpler and fully separate, but it would duplicate what Temporal
  already gives: durable timers, history, replay, and visibility queries next to the agent's tasks. Kill-switch and purge
  handling would also have to be rebuilt.
- **One global Signals context.** A single administration context for the platform, with each expectation naming an
  agent. Rejected: the agent's role is the context that makes interpretation sensible, cost belongs to the agent's
  budget, and per-agent scoping keeps an injected observation from reaching other agents.
- **Rules engine (if-then).** Predictable, but it misses exactly the cases Signals is for, and its rules become process
  code that people must maintain.

## Consequences

- Observations are untrusted.
  - They are fenced with a nonce in the prompt.
  - The model's answer can only describe events and expectations.
  - The only things a signal can cause are a notification or a task proposal that a person approves.
  - An injected mail can at worst create noise: expectations that people dismiss, and tasks they reject. Limits keep
    that noise bounded: observations per hour, 5 expectations per observation, 200 open per agent, due date within a
    year, and payload caps.
- Every observation costs one model call on the agent's key (small model by default). MQTT limits matter for chatty
  machines.
- The core workflows did not change. The agent's workflow bundle now also contains the Signals workflows, which are
  registered but started only when the module is on.
- Not covered yet: Microsoft Graph mail and calendar, attachments (only their names are forwarded), and a learning
  loop beyond the last corrections. These can be added as further connectors without changing the workflows.
