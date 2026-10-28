# Agentic mitigations: five AI colleagues keep a sofa factory running

Five AI colleagues support the people of a sofa maker, **Sofaworks**, while things go wrong: a supplier fails, a machine
breaks, an ad campaign floods the order book, two workers fall sick, a thunderstorm destroys fabric. The agents work on a
mocked **ERP** and **CRM** (both MCP servers behind the gateway), they hand work to each other (A2A) in an order that the
platform keeps, they remember what they learn in wikis, and **a person decides every essential step**: nothing changes in
ERP or CRM before a person has approved the plan, by e-mail link. What all agents share is governed by people too.

> **Reading guide.** The AI colleagues are written with the postfix **-agent** (Max-agent, Cora-agent, Horst-agent,
> Tom-agent, Lara-agent) so that you can tell them from the humans (Paula, Stefan, Sabine). The screenshots show the
> agents' first names only.

> **The paradigm shift: communication moves from humans to agents.** In a company like this, much of the work of the
> people is passing information along: the warehouse tells procurement, procurement tells planning, planning tells sales,
> sales tells the customer, and every message has to be reconsidered when the state changes, for example when a delivery
> arrives at the warehouse or a repair date moves. Here the agents carry that communication. They read the shared state in
> ERP and CRM, understand how the parts depend on each other (a spare part decides the repair date, the repair date decides
> the plan, the plan decides what the customer is told), ask the right colleague for the right part, and act again when the
> state changes. The people stay in charge of the decisions: they approve plans and give direction, instead of relaying
> messages and re-checking dependencies by hand. This report also shows where that still needs care.

All screenshots come from one real run on the local stack (real model `gpt-5.4-mini`, real gateway, real Temporal). Every
plan, report, wiki page and tool call shown was produced by the agents. The only scripted parts are the company's mock
systems and the people's decisions (see [What is real, what is scripted](#what-is-real-what-is-scripted)).

## Who is who

**People and their agents.** Each person asks for work and decides on the plans of the agents of their area.

```mermaid
flowchart LR
    paula["Paula<br/>Head of Production"] --> max["Max-agent<br/>shop floor"]
    paula --> cora["Cora-agent<br/>production planning"]
    stefan["Stefan<br/>Head of Logistics"] --> tom["Tom-agent<br/>warehouse"]
    stefan --> lara["Lara-agent<br/>procurement"]
    sabine["Sabine<br/>Head of Sales"] --> horst["Horst-agent<br/>sales"]
```

**Who depends on whom.** An arrow means "asks for": the agent at the tail delegates that part of the work to the agent at
the head, whose own person approves again.

```mermaid
flowchart LR
    max["Max-agent"] -->|spare part| lara["Lara-agent"]
    max -->|re-plan| cora["Cora-agent"]
    max -->|customer notices| horst["Horst-agent"]
    tom["Tom-agent"] -->|replacement material| lara
    tom -->|re-prioritise orders| cora
    horst -->|plan new orders| cora
    horst -->|capacity| max
    horst -->|material| lara
    cora -->|capacity| max
    cora -->|material| lara
```

| Agent | Responsible for | May change |
|---|---|---|
| Max-agent | machines, maintenance, staffing | maintenance tickets, overtime, temporary workers |
| Cora-agent | which order runs where and when | production orders (factory, priority, create) |
| Horst-agent | customers, orders, campaigns, promises | customer notices, delivery dates, campaigns |
| Tom-agent | stock, damaged goods | write-off, release, incident report |
| Lara-agent | suppliers, purchase orders | purchase orders |

Every agent reads the whole ERP and CRM but changes only what its own tools allow.

| Person | Role | Approves for |
|---|---|---|
| **Paula Meier** | Head of Production | Max-agent, Cora-agent |
| **Stefan Lang** | Head of Logistics | Tom-agent, Lara-agent |
| **Sabine Roth** | Head of Sales | Horst-agent |

**The company.** Two factories, *Werk Nord* (Hamburg) and *Werk Süd* (Stuttgart), each with three machines in series (frame
cutter, upholstery line, assembly line) and **two workers**. Three models: Lund (2-seater), Oslo (3-seater), Bergen (corner).
Simulation date: **2026-10-05**.

## How a disruption is handled

The same loop runs in every scenario. It is the platform's normal task flow; the mitigations come from what the agents find
in ERP and CRM, not from scripted answers.

```mermaid
sequenceDiagram
    actor P as Person
    participant A as Agent (owner of the area)
    participant S as ERP / CRM (mock)
    participant C as Colleague agents
    P->>A: 1. "Nordholz cannot deliver…" (task, approval: plan)
    A->>S: 2. PLAN step: read tools and what-if simulations only
    A-->>P: 3. Plan with exact tool calls, KPI before → after, cost, by e-mail
    P->>A: 4. Approve / Request changes / Reject (with comment)
    A->>S: 5. EXECUTE step: only the approved changes
    A->>C: 6. Delegate the whole chain at once; the platform starts each task when its predecessors are done
    C-->>P: 7. Their person approves in turn
    C->>S: 8. Colleague executes
    A->>A: 9. Report, then update the agent's own wiki
```

1. **A person describes the problem** to the agent that owns the area, in plain words, with approval mode *plan first*.
2. **The agent plans with read tools only.** It reads ERP and CRM, reads the company wiki and its own wiki, and **simulates**
   its options: a what-if tool applies one change, or a combination of changes, to a copy of the company state and returns the
   KPI before and after. The plan names every change with tool, arguments, simulated effect and cost.
3. **The person gets an e-mail** with *Approve*, *Request changes*, *Reject* and a link to the plan. Clicking a button only
   opens the decision dialog; nothing is decided by the click.
4. **The person decides**, with a comment. *Request changes* sends the agent back to revise the plan.
5. **The agent executes exactly the approved plan.**
6. **Colleagues are asked** (A2A) for the parts that belong to them, **all in the same step**. Work that depends on another
   result is sent with `after`; the gateway then holds it back until the earlier task has completed and passes the result on.
   A colleague's task needs *their* person's approval.
7. **Everything is traceable**: conversation per task, audit trail, mail outbox, Temporal history, and the Git history of the
   agent's workspace, including its wiki.

The business effect is measured by the mock company itself (`GET /kpi`), independent of what any agent says.

## What the platform does for this

| Capability | What it does |
|---|---|
| **Read-only planning, enforced** | An MCP server declares which tools only read (`readOnlyHint`). The gateway knows the step of the running task and refuses, in the plan step, every tool that changes data and every delegation. |
| **Plan-aware security check** | The check of each tool call sees the plan a person approved, so a call that carries out the plan is told apart from one that deviates from it. Tools their server declares read-only can be exempted (an opt-in, switched on here). |
| **What-if before proposing** | The mock ERP offers `simulate_change` (one change or a whole sequence, on a copy of the state) and `get_kpi`. Plans cite simulated numbers instead of estimates. |
| **Ordered delegation** ([ADR-0036](docs/adr/0036-ordered-delegation.md)) | `a2a__send_task` takes `after`. The gateway starts a task only when everything it depends on has completed, hands over the results, and cancels it if a predecessor fails. The execute and integrate steps require that every delegation the plan names is actually sent. |
| **A wiki per agent** | Each agent keeps Markdown pages in its own Git workspace; the platform puts the index in front of every plan and execute step so that the memory is used. |
| **A company wiki that people govern** ([ADR-0035](docs/adr/0035-company-wiki.md)) | One wiki for all agents behind the gateway. Agents read, search and **propose**; a person approves, edits or rejects in the admin console. |

## The mock company

[`scripts/sofa-company/mock-mcp.mjs`](scripts/sofa-company/mock-mcp.mjs) is one dependency-free process serving two MCP
servers (`/erp/mcp`, `/crm/mcp`, 31 tools). It is a **deterministic simulation**, not canned text: production is simulated
day by day from the current state (capacity of each factory, order queues, material stock, purchase-order arrivals). What
agents read (completion dates, late orders, stock-out dates) is derived from that state, and each write tool changes it, so
a mitigation either works in the simulation or it does not.

![ERP/CRM status page, baseline](docs/images/mitigations/s0-erp-baseline.png)

Rules the agents work with: a regular worker makes 20 sofas a day, a temporary worker 15 (available three workdays after
booking), a factory tops out at 48 a day, overtime adds 25 % (EUR 1,400 per factory and day); a machine that is down stops the
whole factory; a repair starts only when the spare part has arrived and takes two workdays; suppliers have lead times, prices,
order limits and an express option; each production order has a priority (5 by default), and moving work into a busy factory
delays that factory's own orders.

## Results at a glance

"Late" means: the simulation expects delivery after the date promised to the customer. In scenario 3 the starting point is
0 late orders and 8 confirmed orders that nobody has planned yet (970 sofas). "Spend" is the value of what was bought or
booked, not extra cost.

| # | Disruption | Late orders before → after | Spend | Delegation chain | Decisions by people |
|---|---|---|---|---|---|
| 1 | [Supplier cannot deliver wood beams](#1-a-supplier-cannot-deliver-the-wood-beams) | 13 → **0** | EUR 42,450 | none needed | 1 |
| 2 | [Machine fails](#2-a-machine-in-production-fails) | 9 → **2** | EUR 9,650 | Lara-agent → Cora-agent → Horst-agent | 4 |
| 3 | [Ad campaign spikes demand](#3-an-ad-campaign-causes-a-spike-in-demand) | 0 (8 unplanned) → **8** | none | three tasks in parallel | 5 |
| 4 | [Two workers sick for two weeks](#4-two-workers-of-one-factory-are-sick-for-two-weeks) | 7 → **0** | EUR 5,200 | Cora-agent → Horst-agent | 3 |
| 5 | [Storm damages the fabric](#5-a-thunderstorm-damages-the-upholstery-fabric) | 8 → **0** | EUR 87,720 | Lara-agent, then Cora-agent | 3 |

Three of five disruptions were resolved completely, one was mitigated (two orders still late, their customers not yet told),
one was not resolved. 16 decisions by people were needed, one of them *request changes*. The sections below tell each
story step by step.

## 1. A supplier cannot deliver the wood beams

**Situation.** Nordholz, the sawmill, reports kiln damage: no pine beams before 2026-11-30, both open purchase orders are
postponed. Stock lasts until 2026-10-14; from 2026-10-15 production is held back. **13 orders, 1,260 sofas** would be late.

![ERP status after the supplier failure](docs/images/mitigations/s1-01-erp-after-incident.png)

**Step by step**

1. **Stefan asks Lara-agent** (procurement) to secure supply and keep frame production running.
2. **Lara-agent plans, read-only, and simulates.** She reads stock, projection, suppliers and the bill of materials and tests
   the options with the what-if tool, including combinations of purchase orders. Her plan names the package that brings the
   KPI to zero: 6,000 beams express from Baltic Timber and 3,000 from Silesia Wood.

   ![Lara-agent's plan with the simulated options](docs/images/mitigations/s1-03-plan-lara.png)

3. **Stefan receives the approval mail** and **decides** in the dialog it opens. His comment: *"Approved. Keep Nordholz's
   postponed orders open, we will not cancel them."*

   ![Approval mail in the outbox](docs/images/mitigations/s1-04-approval-mail-lara.png)
   ![Decision dialog opened from the mail](docs/images/mitigations/s1-05-decision-dialog-lara.png)

4. **Lara-agent executes** exactly that: two purchase orders, EUR 42,450 committed. She cancels nothing, as asked.
5. **Result.** Production is no longer held back: **0 late orders**, no customer affected, no colleague needed.

   ![ERP status after the mitigation](docs/images/mitigations/s1-06-erp-after-mitigation.png)

The what-if tool is what makes this plan good: it lets the agent compare packages of changes with numbers, not guesses. A
tool that could only test one change at a time would have led to the best single order and a remaining shortage.

## 2. A machine in production fails

**Situation.** The CNC frame cutter **N-CUT-1** in Werk Nord stops (spindle drive error). It is the bottleneck, so Werk Nord
produces nothing. No spare spindle motor is in stock and nobody has ordered one: without a purchase order the repair date is
unknown. **9 orders, 860 sofas** would be late.

![ERP status after the machine failure](docs/images/mitigations/s2-01-erp-after-incident.png)

**Step by step**

1. **Paula asks Max-agent** (production) to get it repaired fast and keep deliveries on track, naming the colleagues he may
   involve.
2. **Max-agent plans**: open a maintenance ticket, have Lara-agent order the spare part by the fastest route, then Cora-agent
   re-plans with the new date, then Horst-agent informs the customers whose promise is broken. He rejects overtime and
   temporary workers: the simulation showed no KPI gain for the cost.

   ![Max-agent's plan](docs/images/mitigations/s2-03-plan-max.png)

3. **Paula approves** (*"Take the fastest repair path, the cutter is the bottleneck of the whole plant."*).

   ![Approval mail](docs/images/mitigations/s2-04-approval-mail-max.png)
   ![Decision dialog](docs/images/mitigations/s2-05-decision-dialog-max.png)

4. **Max-agent opens ticket `MT-001` and delegates the whole chain at once.** The screen shows what the platform enforces:
   Lara-agent is running, Cora-agent is **queued** (*"Waiting for sofa-lara to finish first"*), Horst-agent is queued
   (*"Waiting for sofa-cora to finish first"*). Nobody has to remember the order later.

   ![The delegation chain: one running, two queued](docs/images/mitigations/s2-06-delegating-max.png)

5. **Lara-agent plans, Stefan approves** (*"The express surcharge is justified for this part."*), and she orders spare part
   `SP-SPINDLE-220` as `PO-4430`: express, EUR 9,200, arrival 2026-10-09. The repair is scheduled; **N-CUT-1 is back on
   2026-10-13**.
6. **Only now Cora-agent starts**, with Lara-agent's result in her request. She moves the two late North orders to Werk Süd,
   the only moves her simulation confirmed as an improvement, and Paula approves her plan.

   ![Cora-agent's plan](docs/images/mitigations/s2-10-plan-cora.png)

7. **Then Horst-agent starts**, with Cora-agent's result. Sabine approves his plan.

   ![Horst-agent's plan](docs/images/mitigations/s2-13-plan-horst.png)

**Result.** **Late orders 9 → 2** (860 → 220 sofas late). The chain ran in the right order and every link had its own approver.
One thing went wrong in the content: Max-agent's request to Horst-agent named only the North orders, Horst-agent found none of
them late and sent nothing, but Cora-agent's moves had pushed two South orders late. **Those two customers were not told.**
The order of work was enforced; what each request contains still depends on the agent that writes it. How this was
followed up is in [the company wiki chapter](#what-the-company-wiki-did-in-this-run).

![ERP status after the mitigation](docs/images/mitigations/s2-16-erp-after-mitigation.png)
![Max-agent's task completed, with the colleagues' results](docs/images/mitigations/s2-17-done-max.png)

## 3. An ad campaign causes a spike in demand

**Situation.** The autumn campaign works almost too well: order intake is **42 % above plan**, eight confirmed sales orders
(**970 sofas**) have no production order yet, and the campaign runs until 31 October.

![ERP status with the unplanned orders](docs/images/mitigations/s3-01-erp-after-incident.png)

**Step by step**

1. **Sabine asks Horst-agent** (sales) to make the volume deliverable without stopping the campaign.
2. **Horst-agent plans**, and his first plan proposes to pause or sharply cut the campaign.

   ![Horst-agent's first plan](docs/images/mitigations/s3-03-plan-horst.png)

3. **Sabine requests changes.** This is the steering that a plain approve/reject would not allow: *"Please do not stop the
   campaign. Throttle it, but keep at least half of the daily budget running."* Horst-agent revises his plan.

   ![Changes requested](docs/images/mitigations/s3-06-revision-requested-horst.png)
   ![Revised plan](docs/images/mitigations/s3-07-plan-horst.png)

4. **Sabine approves the revised plan.** Horst-agent throttles the campaign to **50 %** and delegates to Cora-agent, Max-agent
   and Lara-agent, **all three at once and without `after`**.

   ![Horst-agent waits for the colleagues](docs/images/mitigations/s3-10-delegating-horst.png)

5. **The colleagues plan, their people approve.** Cora-agent creates the eight production orders (priority 6, so existing
   orders keep their place). Max-agent and Lara-agent check capacity and material **while the orders are not in the ERP yet**,
   see nothing wrong, and book nothing.

   ![Max-agent's plan](docs/images/mitigations/s3-14-plan-max.png)

**Result: not resolved.** All eight orders are planned, but **8 orders are late (970 sofas)** and a foam shortage starts on
2026-11-12; no customer was told. This is the failure mode that ordered delegation prevents, and it happened because it was
not used: the three tasks depend on each other (planning first, then capacity and material for the plan as it then stands),
but Horst-agent sent them in parallel. The platform keeps an order only when the agent declares it.

![ERP status after the mitigation](docs/images/mitigations/s3-20-erp-after-mitigation.png)

## 4. Two workers of one factory are sick for two weeks

**Situation.** Both workers of Werk Süd, Lena Hartmann and Tobias Klein, are on sick leave from 2026-10-12 to 2026-10-23. The
factory's capacity falls to **0** for ten workdays. **7 orders, 770 sofas** would be late.

![ERP status after the sick leave](docs/images/mitigations/s4-01-erp-after-incident.png)

**Step by step**

1. **Paula asks Max-agent** to keep Süd's orders on time and to involve Cora-agent and Horst-agent if needed.
2. **Max-agent plans**: book **two temporary workers** for the absence window (the simulation showed that this alone brings the
   KPI to zero), then Cora-agent checks the schedule, then Horst-agent informs customers whose promise still breaks. No
   overtime: it cannot bridge a ten-day gap.

   ![Max-agent's plan](docs/images/mitigations/s4-03-plan-max.png)

3. **Paula approves**; Max-agent books the temporary workers for 2026-10-12 to 2026-10-23 (EUR 5,200) and sends the chain:
   Cora-agent first, Horst-agent after her.

   ![Max-agent waits for Cora-agent and Horst-agent](docs/images/mitigations/s4-06-delegating-max.png)

4. **Cora-agent** names the pages she read in her plan, among them **her own lesson from the campaign scenario** (*a healthy queue
   can still fail after a change, so verify the KPI after any change*). She re-simulates, finds that no order needs to move and
   **changes nothing**. Paula approves.

   ![Cora-agent's plan](docs/images/mitigations/s4-07-plan-cora.png)

5. **Horst-agent starts only after Cora-agent's result**, sees that no promise is broken, and sends no notice. Sabine approves
   his plan, which says exactly that.

   ![Horst-agent's plan](docs/images/mitigations/s4-10-plan-horst.png)

**Result.** **7 → 0 late orders**, no customer affected, EUR 5,200.

![ERP status after the mitigation](docs/images/mitigations/s4-13-erp-after-mitigation.png)

## 5. A thunderstorm damages the upholstery fabric

**Situation.** The storm damaged the roof of the fabric hall. A surveyor's note in the ERP says: of the Oatmeal lot, 7,200 m
are water-damaged and 1,800 m usable; of the Anthracite lot, 6,800 m damaged and 1,700 m usable. Both lots are quarantined,
so nearly all fabric is unusable. **8 orders, 760 sofas** would be late.

![ERP status after the storm](docs/images/mitigations/s5-01-erp-after-incident.png)

**Step by step**

1. **Stefan asks Tom-agent** (warehouse) to handle the damaged stock and to make sure production does not run out of fabric, by
   asking Lara-agent and Cora-agent.
2. **Tom-agent plans** the write-offs and releases from the surveyor's note, an incident report for the insurance, and the two
   follow-ups.

   ![Tom-agent's plan](docs/images/mitigations/s5-03-plan-tom.png)

3. **Stefan approves**: *"Only the quantities named by the surveyor."* Tom-agent executes: writes off 7,200 m Oatmeal and
   6,800 m Anthracite (EUR 165,200 of goods), releases 1,800 m and 1,700 m, files the storm incident report. A write-off
   cannot be undone, which is why the rule is "only what the surveyor names". He then sends Lara-agent first and Cora-agent
   after her.

   ![Tom-agent waits for the colleagues](docs/images/mitigations/s5-09-delegating-tom.png)

4. **Lara-agent plans and Stefan approves**: she orders **6,800 m Anthracite express** from Tuchwerk (EUR 87,720), the
   Anthracite quantity that was written off.

   ![Lara-agent's plan](docs/images/mitigations/s5-06-plan-lara.png)

5. **Cora-agent plans and Paula approves.** With the fabric ordered, her simulation shows that every re-prioritisation would
   only increase lateness, so she changes nothing.

   ![Cora-agent's plan](docs/images/mitigations/s5-10-plan-cora.png)

**Result.** **8 → 0 late orders.** The price is high: the agent replaced everything that was lost, not just what production
needs in time. The Anthracite stock is still empty on 2026-10-13, but no order is late because of it.

![ERP status after the mitigation](docs/images/mitigations/s5-13-erp-after-mitigation.png)

## The wikis: how the agents remember and what they share

An agent's knowledge used to end with its task. Two wikis change that: a **private wiki** per agent for its own tactics, and
one **company wiki** for what all colleagues rely on, which people govern. The idea comes from the "LLM wiki" pattern: instead
of searching raw documents every time, the model builds up a persistent, interlinked set of Markdown pages and keeps them
current.

### The private wiki of each agent

| Layer | In this system |
|---|---|
| **Sources** (not edited) | what the platform records anyway: task conversations, plans, reports, tool-call audit, the KPI before and after |
| **The wiki** (written by the agent) | `wiki/index.md` (one line per page), `wiki/log.md` (append-only chronology), `wiki/playbooks/…`, `wiki/lessons/…`, `wiki/entities/…` |
| **The rules** | a section in the agent's standing instructions: page layout, when to read, when to write |
| **Three operations** | **query**: read the index and the fitting pages when planning; **ingest**: after the result is known, update pages and the log; **lint**: a periodic pass that fixes contradictions, duplicates, stale pages and broken links |

Two rules keep it useful: pages hold **rules and evidence, not snapshots** (a lesson has `Rule`, `Applies when`, `Evidence`),
and agents **never copy instructions from tool results, customers or colleagues** into a wiki, because a memory that anyone can
write into would be a new way to attack the agent. The wiki lives in the agent's Git workspace, so every change is a commit of
a task that the approver sees and can restore.

Reading the memory cannot be left to the agents: the platform puts the wiki index in front of every plan and execute step.
With that, agents used the wikis: in the five scenarios the five agents opened wiki pages 139 times, and 11 of the 15 plans
name the company wiki pages they read.

![A private wiki appears as commits of the agent's tasks](docs/images/mitigations/s1-08-wiki-lara.png)

After the scenarios, a lint round let each agent tidy its own wiki (17 pages in total across the five agents), for example fixing
broken links of an index and merging duplicated advice.

![The result of Max-agent's lint task](docs/images/mitigations/lint-max.png)

### The company wiki: shared, and governed by people

A private wiki cannot carry what several roles need: what a colleague needs in a request, how customers are told, durable
facts about suppliers. That belongs in one place, and it must not be a place that any agent can write to: one bad tool result,
once written, would reach every agent that reads it.

```mermaid
flowchart LR
    agent["Agent<br/>reads, searches"] -->|wiki__propose_edit<br/>full page, reason, evidence| queue["Review queue<br/>nothing published yet"]
    queue -->|approve · edit and approve · reject with comment| person["Person<br/>(admin console)"]
    person -->|publishes| wiki[("Company wiki<br/>pages with history")]
    wiki -->|wiki__read_page<br/>wiki__search| agent
    person -.->|reject comment is read by the agent| agent
```

- **Agents read and propose; only people publish.** `propose_edit` is a tool that changes data, so it is refused while planning
  and needs an approved plan. The gateway sets the author and the task of each proposal; the agent cannot forge them.
- **A review queue with the diff**, the reason and the evidence in front of the reviewer, who can approve, **edit and approve**,
  or reject with a comment that the agent reads before it proposes again.
- **Content rules:** only slowly changing knowledge for the whole company (rules, protocols, durable facts, decisions with
  reasons). Never live state: ERP and CRM stay the truth for numbers and dates.
- **Seeded by people:** the run started with seven pages published by the people: company overview, handoffs between
  colleagues, ordered delegation, customer notices, capacity levers, suppliers, and an index.

![The published pages of the company wiki](docs/images/mitigations/company-wiki-pages.png)

### What the company wiki did in this run

**The agents read it.** 11 of 15 plans cite it, typically with the protocols for requests to colleagues and the rule for
customer notices. In scenario 4, Cora-agent's plan cites a lesson page that she wrote herself in scenario 3.

**They did not propose anything on their own.** The retrospective round shows why: each person asked their agent to look back
and propose what holds for the whole company. Four of five agents answered, with their reasons, that the seeded wiki already
covered what they had learned. Cora-agent proposed one page, a rule about "post-change verification", which restated what the
company overview already says. As the reviewer I **rejected it with a comment** that named what the incident had really
taught: the order of checks, material first, then capacity, then the KPI.

![The retrospective plan that Stefan approved for Lara-agent](docs/images/mitigations/retro-plan-lara.png)

**Guided proposals work.** When Cora-agent was asked to write up that checklist and Horst-agent to write up the notice gap of
scenario 2, with the evidence handed over by the person, both proposals arrived. The queue shows the diff:

![The review queue with two proposals](docs/images/mitigations/company-wiki-review-queue.png)

I **approved the notice rule as proposed** (a new line: take the customers to inform from the CRM list of late orders, not
only from the ids named in the request) and **approved the checklist with a correction** (I added why the order matters and
named the incident). The rejection, the approval and the edit are all kept:

![Decided proposals with the reviewer's comments](docs/images/mitigations/company-wiki-decided.png)

**Did the new pages change behaviour?** Scenarios 2 and 3 were run again with them published. Horst-agent read the new rule
and, in the first attempt, got as far as sending customer notices (the call was then stopped by the security check and that
attempt was restarted; the later attempts did not complete the chain). In scenario 3, Horst-agent's plan cites the release checklist, Lara-agent
bought foam first, and Max-agent booked one temporary worker, which moved the spend from none to EUR 14,455; the result stayed
at 8 late orders, now with a beam shortage from 2026-11-18. The wiki changed what the agents did, not yet what they achieved.
Two runs are an indication, not a measurement.

### Would a shared wiki help, in general?

The research suggests: yes for stable knowledge, with strict rules for who writes, and no for problems of parallel work on
live state. The evidence is thin and mostly preprints and engineering blogs.

- *For:* blackboard-style systems, where agents read and write one shared board, are reported to beat static and
  retrieval-based baselines: a Google-affiliated data-science system reports 13 % to 57 % relative gains in end-to-end success
  ([Blackboard Multi-Agent Systems for Information Discovery in Data Science](https://research.google/pubs/blackboard-multi-agent-systems-for-information-discovery-in-data-science/)),
  LbMAS reports competitive accuracy with fewer tokens ([Han and Zhang, 2025](https://arxiv.org/abs/2507.01701)); both are the
  authors' own benchmarks. File-based, scoped, shared memory with logged and reversible writes is also what Anthropic's
  managed-agents memory is described as ([SD Times](https://sdtimes.com/anthropic/anthropic-adds-memory-to-claude-managed-agents/),
  secondhand).
- *Against, or for care:* a 2026 preprint on governed shared memory names four failure modes: leakage, stale propagation,
  contradiction persistence and provenance loss ([summary of arXiv 2606.24535](https://www.emergentmind.com/papers/2606.24535)); a
  practitioner write-up describes how one bad tool response spreads to every reader of a shared store
  ([Agent Memory Contamination](https://tianpan.co/blog/2026/05/05/agent-memory-contamination-tool-response-poison)); MemCollab
  reports that memory written by one model can hurt another ([arXiv 2603.23234](https://arxiv.org/abs/2603.23234)); and a 2026
  position paper argues that many multi-agent failures are concurrency-control problems, stale reads and lost updates on shared
  state ([ICML 2026](https://proceedings.mlr.press/v306/yang26dy.html)).

The design here answers these points with a human as the only writer, provenance on every proposal, page history, a reviewer's
comment that the agent reads, and a strict split: knowledge in the wiki, live state in the ERP and CRM. It does not answer the
concurrency problem. That is what ordered delegation is for, and scenario 3 shows what happens without it.

## Findings

**1. The human gate works, and it changes outcomes.** 16 decisions by people in the five scenarios, one of them *request
changes* (scenario 3), which sent the agent back to a different plan. The approver sees concrete tool calls, quantities,
simulated KPI and costs. Planning is read-only by enforcement.

**2. Tools bound the quality of the agents' decisions.** The what-if tool, with combinations of changes, is why scenario 1
ends at zero late orders and why several agents chose to change nothing when the simulation showed that a change would hurt.

**3. Ordered delegation turns an instruction into a guarantee, but only where it is used.** In scenarios 2, 4 and 5 the chains
ran in the declared order, with a separate approval at each link and the predecessor's result in the next request. Scenario 3
shows the other side: Horst-agent sent three dependent tasks in parallel, and the result was a plan that nobody had checked
as a whole. What is still open: a check that the agent sends everything its plan names, and a way to derive the dependency
from the kind of work, so that it does not depend on the agent's choice.

**4. The content of a handoff matters as much as its order.** Scenario 2's missing customer notices came from a request that
named the wrong set of orders. The company wiki now has the rule; its effect needs more runs than this report has.

**5. A shared memory is only as good as its reviewing.** Agents read the wikis and propose rarely; people decide what becomes
company knowledge. In this run the reviewer was needed to turn a restated rule into a useful one.

**6. Plans are checkable, and numbers come from the system.** Because every plan names its tool calls, the approver can compare
it with what happened. Success in this document is taken from the simulation's KPI, not from any agent's report.

## What is real, what is scripted

| Real | Scripted |
|---|---|
| model (`gpt-5.4-mini`), plans, simulations, tool choices, reports, customer notice texts, wiki pages and proposals | the company's ERP and CRM (a simulation, simplified: one warehouse, three products, fixed prices and capacities) |
| gateway, allow-lists, A2A with ordered delegation, Temporal workflows, workspace commits, mail outbox, the company wiki and its review queue | the five disruptions (injected by `POST /scenario/<id>/start`) |
| the security check of tool calls, with the approved plan as context | **the people**: [`run.mjs`](scripts/sofa-company/run.mjs) signs in as Paula, Stefan or Sabine through the real sign-in page, opens the plan and the decision dialog, and decides with a prepared comment; "request changes" in scenario 3 is triggered when the plan proposes to pause the campaign. The review of the company wiki was done by the person running the example, carried out with [`steward.mjs`](scripts/sofa-company/steward.mjs). |

Further limits: one run per scenario (a scenario was started again from scratch when an agent was halted by the security check:
scenario 3 twice, scenario 4 once), a probabilistic model, so another run will differ. The scenarios ran in the order 2, 3, 4,
5, 1 on freshly created agents, followed by a lint round, a retrospective round and the guided proposals. Findings about the
company wiki rest on very few cases. The sofa company is a fictional example, and the numbers show how the platform behaves
with this mock, not how much an agent system would save in a real factory.

## Run it yourself

Prerequisites: the stack runs (`node scripts/stack.mjs up`; after pulling these changes run `node scripts/stack.mjs env` to add
the wiki tokens and rebuild with `docker compose --profile build build`) and `OPENAI_API_KEY` is set (see
[getting started](docs/getting-started.md)).

```bash
# 1. the mock ERP/CRM (the company wiki container is part of the stack)
docker compose -f docker-compose.yml -f docker-compose.sofa.yml up -d --no-deps mcp-sofa

# 2. five agents with instructions, three people with roles, and the seed pages of the company wiki
node scripts/sofa-company/setup.mjs

# 3. run the scenarios; screenshots need Chromium via playwright-core
cd scripts/sofa-company && npm install && cd ../..
node scripts/sofa-company/run.mjs --order 2,3,4,5,1 --lint     # [--only 1,2] [--no-shots]

# 4. the people review the company wiki: list what agents proposed, decide in a file (or in the admin console, "Company wiki")
node scripts/sofa-company/steward.mjs
node scripts/sofa-company/steward.mjs --decide decisions.json
```

A retrospective round (`run.mjs --order 99 --retro`) asks every agent to propose what the whole company should know;
`--retro-agent`, `--retro-title` and `--retro-text` target one agent with your own request.

| What | Where |
|---|---|
| Mock ERP and CRM, status page at <http://localhost:7660> | [`scripts/sofa-company/mock-mcp.mjs`](scripts/sofa-company/mock-mcp.mjs), [`docker-compose.sofa.yml`](docker-compose.sofa.yml) |
| Company wiki (MCP upstream, review queue in the admin console) | [`apps/mcp-wiki`](apps/mcp-wiki), [`apps/admin-web/src/pages/WikiPage.tsx`](apps/admin-web/src/pages/WikiPage.tsx), [ADR-0035](docs/adr/0035-company-wiki.md) |
| Ordered delegation | [`apps/mcp-gateway/src/delegationQueue.ts`](apps/mcp-gateway/src/delegationQueue.ts), [ADR-0036](docs/adr/0036-ordered-delegation.md) |
| Setup, seed pages, wiki rules, runner | [`setup.mjs`](scripts/sofa-company/setup.mjs), [`company-wiki/`](scripts/sofa-company/company-wiki), [`wiki-instructions.md`](scripts/sofa-company/wiki-instructions.md), [`run.mjs`](scripts/sofa-company/run.mjs), [`shots.mjs`](scripts/sofa-company/shots.mjs) |
| Per scenario: plans, decisions, reports, KPIs before and after, every change in ERP/CRM, the agents' wikis | `scripts/sofa-company/results/*.json` (`s…` the five scenarios, `wiki-lint.json`, `retro*-retrospective.json`, `cw-…` the rerun of scenarios 2 and 3 with the reviewed company wiki) |
| Screenshots | [`docs/images/mitigations/`](docs/images/mitigations) |

The people sign in with password `DEMO_USER_PASSWORD` from `.env`: `paula.meier@sofaworks.example`,
`stefan.lang@sofaworks.example`, `sabine.roth@sofaworks.example`. To remove everything: delete the agents `sofa-*` and the
upstreams `erp`, `crm` in the admin console, and run
`docker compose -f docker-compose.yml -f docker-compose.sofa.yml rm -sf mcp-sofa`.
