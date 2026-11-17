# UI review: before and after

The review covered every screen: the admin console, the Liquid Enterprise pages, the agent UI, the app host and
the sign-in page. Each screen has an ID. The ID appears in code comments (`UI review ADM-04`) and in the screenshot
script. Screenshots are 1440 px wide, full page, taken from the running demo stack (sofa company) with
`node scripts/review/ui-shots.mjs before|after [ID ...]`.

## Review subjects

| Subject | What changed |
|---|---|
| Visual overload | Long pages are split up. Rows that only matter for diagnosis are folded or moved into the IT view. Long lists are paged. |
| Screens by task, consistent navigation | The navigation is grouped by task: Overview · Agents and people · Knowledge · Security and operations · Liquid enterprise. Group order is the same in every role view. Sequential processes show a stepper: the proposal lifecycle, the task lifecycle, app registration and extension operations. |
| Roles | A switch in the app bar: **IT Engineer** · **Business Engineer** · **All**. It filters the navigation, tabs and sections. It is a per-browser preference, not a permission: the server still decides what a person may do. It can be set by link (`?role=it`). |
| Many sections | Tab strips, each with its own link (`?tab=`; second level `?tab.sub=`), and folded sections with a one-line summary. |

### Building blocks

All of them are in `apps/admin-web/src/components/Sections.tsx`:

- `RoleViewSwitch`, `useRoleView`, `forView`: the role view.
- `SectionTabs`: tabs with an optional second level, a count badge and role filtering, synced to the URL.
- `Section`: a collapsible block with a summary line.
- `ProcessStepper`: the steps of a process, with the current step and any failed step marked.
- `usePaged`: client-side paging for long lists.

The agent UI uses the same MUI components (Stepper, Tabs, Accordion) directly.

### Role views

| Area | IT Engineer | Business Engineer |
|---|---|---|
| Navigation | Dashboard, Agents, Users & access, Safety & tools, Audit log, Mail outbox, Extensions; Liquid: Overview, Approvals, Policies, Proposals, Playbooks, Event log, Apps | Dashboard, Agents, Company wiki, Signals; Liquid: Overview, Approvals, Ontology, Business processes, Proposals, Apps |
| Dashboard | Metrics, platform services, AI gateway, security banner, agents with container state | Metrics, agents, recent tasks |
| Agent detail | All five groups | Overview, Work, Profile (without Settings) |
| Liquid overview | Control-loop health, installation, lake | What is waiting: proposals, approvals, held processes, expiring apps |

## Page length

Full page at 1440 px width, in px.

| ID | Screen | Before | After |
|---|---|---:|---:|
| ADM-01 | Dashboard | 2,837 | 1,767 |
| ADM-02 | Agents | 2,410 | 2,160 |
| ADM-03 | Agent detail | 900 | 900 |
| ADM-04 | Safety & tools | 13,945 | 926 |
| ADM-05 | Company wiki | 900 | 900 |
| ADM-06 | Mail outbox | 19,387 | 1,764 |
| ADM-07 | Users & access | 900 | 900 |
| ADM-08 | Audit log | 29,804 | 2,808 |
| ADM-09 | Extensions | 1,294 | 900 |
| ADM-10 | Signals | 900 | 900 |
| LIQ-01 | Liquid overview | 1,592 | 900 |
| LIQ-02 | Approvals | 900 | 900 |
| LIQ-03 | Ontology | 924 | 924 |
| LIQ-04 | Policies | 1,402 | 900 |
| LIQ-05 | Business processes | 2,928 | 900 |
| LIQ-06 | Proposals | 1,907 | 900 |
| LIQ-07 | Proposal detail | 2,629 | 1,101 |
| LIQ-08 | Playbooks | 6,720 | 900 |
| LIQ-09 | Event log | 8,116 | 1,315 |
| LIQ-10 | Apps | 1,297 | 900 |
| AGT-01 | Agent chat | 1,522 | 1,522 |
| AGT-02 | Tasks | 1,522 | 1,522 |
| AGT-03 | Task detail | 1,902 | 1,414 |
| AGT-04 | Timeline | 900 | 900 |
| AGT-05 | Schedules | 1,163 | 1,163 |
| AGT-06 | Signals (agent) | 1,522 | 900 |
| AGT-07 | Audit (agent) | 900 | 900 |
| AGT-08 | Workspace | 1,532 | 1,532 |
| APP-01 | App host | 900 | 900 |
| APP-02 | Sample app | 900 | 900 |
| AUTH-01 | Sign-in | 900 | 900 |

Data changed between the two runs (new tasks, new alerts), which moves some heights by a few rows. Screens whose
two shots are not comparable say so below.

## Screens

### ADM-01 · Dashboard

**Role:** All (content per role)  
**Finding:** Three service cards, five metrics, the AI gateway card with spend per agent, the agents table and 15 recent tasks on one page; the security banner listed three alerts in full.  
**Change:** One row of five metrics first. Platform services and AI gateway/spend are folded sections (IT view only; the services section opens by itself when a service is down). The banner is one line (newest alert, link to the alerts tab). 10 recent tasks. Business view: no banner, no container column.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-01.png"><img src="img/before/ADM-01.png" width="430" alt="ADM-01 before"></a></td>
<td valign="top"><a href="img/after/ADM-01.png"><img src="img/after/ADM-01.png" width="430" alt="ADM-01 after"></a></td>
</tr></table>

<table><tr><th>ADM-01-IT · IT Engineer view</th><th>ADM-01-BE · Business Engineer view</th></tr><tr><td valign="top"><a href="img/after/ADM-01-IT.png"><img src="img/after/ADM-01-IT.png" width="430" alt="ADM-01-IT"></a></td><td valign="top"><a href="img/after/ADM-01-BE.png"><img src="img/after/ADM-01-BE.png" width="430" alt="ADM-01-BE"></a></td></tr></table>

### ADM-02 · Agents

**Role:** All  
**Finding:** Every card had 10 key/value rows (health, kill switch, peers, harness, workspace, open tasks, model, spend, image, port).  
**Change:** Health, kill switch, workspace state and an exceeded spend limit are chips. Three facts for everyone (peers, open tasks, spend); model, harness, image and port only in the IT view.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-02.png"><img src="img/before/ADM-02.png" width="430" alt="ADM-02 before"></a></td>
<td valign="top"><a href="img/after/ADM-02.png"><img src="img/after/ADM-02.png" width="430" alt="ADM-02 after"></a></td>
</tr></table>

<table><tr><th>ADM-02-BE · Business Engineer view</th></tr><tr><td valign="top"><a href="img/after/ADM-02-BE.png"><img src="img/after/ADM-02-BE.png" width="430" alt="ADM-02-BE"></a></td></tr></table>

### ADM-03 · Agent detail

**Role:** All (groups per role)  
**Finding:** 14 tabs in one scrollable strip (Overview … Audit); which tab holds what was hard to guess.  
**Change:** Five groups with a second level: Overview · Work (Tasks, Instructions, Collaboration, Signals) · Profile (Identity, Portrait, Settings) · Security & access (Access, Safety, AI & budget) · Operations (Monitoring, Logs, Audit). Security, Operations and Settings are IT only. Every tab has a link (<code>?tab=work&amp;tab.sub=tasks</code>).

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-03.png"><img src="img/before/ADM-03.png" width="430" alt="ADM-03 before"></a></td>
<td valign="top"><a href="img/after/ADM-03.png"><img src="img/after/ADM-03.png" width="430" alt="ADM-03 after"></a></td>
</tr></table>

<table><tr><th>ADM-03-WORK · Work → Tasks</th><th>ADM-03-BE · Business Engineer view (Profile)</th></tr><tr><td valign="top"><a href="img/after/ADM-03-WORK.png"><img src="img/after/ADM-03-WORK.png" width="430" alt="ADM-03-WORK"></a></td><td valign="top"><a href="img/after/ADM-03-BE.png"><img src="img/after/ADM-03-BE.png" width="430" alt="ADM-03-BE"></a></td></tr></table>

### ADM-04 · Safety & tools

**Role:** IT Engineer  
**Finding:** Seven areas on one page of 13,945 px: every security alert as a full card, then kill switch, triggers, guard, gateway, credentials, collaboration.  
**Change:** Seven tabs; the alerts tab shows the open count as a badge. Alerts are a compact table: one line per alert, the blocked call on click, an Open/All filter, 10 rows and “Show more”.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-04-top.png"><img src="img/before/ADM-04-top.png" width="430" alt="ADM-04 before"></a><br><sub>top 2,700 px of 13,945; <a href="img/before/ADM-04.png">full page</a></sub></td>
<td valign="top"><a href="img/after/ADM-04.png"><img src="img/after/ADM-04.png" width="430" alt="ADM-04 after"></a></td>
</tr></table>

### ADM-05 · Company wiki

**Role:** Business Engineer  
**Finding:** Already one task per screen.  
**Change:** No change; shown in the Business and All views.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-05.png"><img src="img/before/ADM-05.png" width="430" alt="ADM-05 before"></a></td>
<td valign="top"><a href="img/after/ADM-05.png"><img src="img/after/ADM-05.png" width="430" alt="ADM-05 after"></a></td>
</tr></table>

### ADM-06 · Mail outbox

**Role:** IT Engineer  
**Finding:** Every mail in the list (19,387 px); the delivery note always shown.  
**Change:** List paged by 20; the preview stays in view while scrolling (sticky); the delivery note appears only when no mail API is configured.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-06-top.png"><img src="img/before/ADM-06-top.png" width="430" alt="ADM-06 before"></a><br><sub>top 2,700 px of 19,387; <a href="img/before/ADM-06.png">full page</a></sub></td>
<td valign="top"><a href="img/after/ADM-06.png"><img src="img/after/ADM-06.png" width="430" alt="ADM-06 after"></a></td>
</tr></table>

### ADM-07 · Users & access

**Role:** IT Engineer  
**Finding:** One table, one task.  
**Change:** No change; IT and All views.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-07.png"><img src="img/before/ADM-07.png" width="430" alt="ADM-07 before"></a></td>
<td valign="top"><a href="img/after/ADM-07.png"><img src="img/after/ADM-07.png" width="430" alt="ADM-07 after"></a></td>
</tr></table>

### ADM-08 · Audit log

**Role:** IT Engineer  
**Finding:** All entries at once (29,804 px), details as wrapped JSON.  
**Change:** Filter field (person, action, target, details), 50 rows per page, details on one line with the full JSON as tooltip.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-08-top.png"><img src="img/before/ADM-08-top.png" width="430" alt="ADM-08 before"></a><br><sub>top 2,700 px of 29,804; <a href="img/before/ADM-08.png">full page</a></sub></td>
<td valign="top"><a href="img/after/ADM-08.png"><img src="img/after/ADM-08.png" width="430" alt="ADM-08 after"></a></td>
</tr></table>

### ADM-09 · Extensions

**Role:** IT Engineer  
**Finding:** Service table and the full step list of the last operation always open.  
**Change:** Services and “Last operation” are folded sections with a one-line summary (“3 of 3 running”, “12 of 12 steps done”). A running or failed operation opens by itself and shows its steps as a vertical stepper.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-09.png"><img src="img/before/ADM-09.png" width="430" alt="ADM-09 before"></a></td>
<td valign="top"><a href="img/after/ADM-09.png"><img src="img/after/ADM-09.png" width="430" alt="ADM-09 after"></a></td>
</tr></table>

<table><tr><th>ADM-09-OPEN · Sections unfolded</th></tr><tr><td valign="top"><a href="img/after/ADM-09-OPEN.png"><img src="img/after/ADM-09-OPEN.png" width="430" alt="ADM-09-OPEN"></a></td></tr></table>

### ADM-10 · Signals

**Role:** Business Engineer  
**Finding:** One task.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/ADM-10.png"><img src="img/before/ADM-10.png" width="430" alt="ADM-10 before"></a></td>
<td valign="top"><a href="img/after/ADM-10.png"><img src="img/after/ADM-10.png" width="430" alt="ADM-10 after"></a></td>
</tr></table>

### LIQ-01 · Liquid overview

**Role:** All (content per role)  
**Finding:** Installation, control-loop health (every check spelled out) and the lake side by side for everyone.  
**Change:** Business view: four tiles for what is waiting (proposals to review, approvals, held processes, apps about to expire), each a link. IT view: health with only the problems spelled out and the ok checks folded; installation and lake as folded sections.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-01.png"><img src="img/before/LIQ-01.png" width="430" alt="LIQ-01 before"></a></td>
<td valign="top"><a href="img/after/LIQ-01.png"><img src="img/after/LIQ-01.png" width="430" alt="LIQ-01 after"></a></td>
</tr></table>

<table><tr><th>LIQ-01-IT · IT Engineer view</th><th>LIQ-01-BE · Business Engineer view</th></tr><tr><td valign="top"><a href="img/after/LIQ-01-IT.png"><img src="img/after/LIQ-01-IT.png" width="430" alt="LIQ-01-IT"></a></td><td valign="top"><a href="img/after/LIQ-01-BE.png"><img src="img/after/LIQ-01-BE.png" width="430" alt="LIQ-01-BE"></a></td></tr></table>

### LIQ-02 · Approvals

**Role:** Business Engineer  
**Finding:** One task.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-02.png"><img src="img/before/LIQ-02.png" width="430" alt="LIQ-02 before"></a></td>
<td valign="top"><a href="img/after/LIQ-02.png"><img src="img/after/LIQ-02.png" width="430" alt="LIQ-02 after"></a></td>
</tr></table>

### LIQ-03 · Ontology

**Role:** Business Engineer  
**Finding:** The editor is already a canvas with a filter and a side panel.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-03.png"><img src="img/before/LIQ-03.png" width="430" alt="LIQ-03 before"></a></td>
<td valign="top"><a href="img/after/LIQ-03.png"><img src="img/after/LIQ-03.png" width="430" alt="LIQ-03 after"></a></td>
</tr></table>

### LIQ-04 · Policies

**Role:** IT Engineer  
**Finding:** Bundle, overlays and recent decisions stacked.  
**Change:** Tabs Overlays (count) · Recent decisions · Bundle. The fail-closed warning stays above the tabs.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-04.png"><img src="img/before/LIQ-04.png" width="430" alt="LIQ-04 before"></a></td>
<td valign="top"><a href="img/after/LIQ-04.png"><img src="img/after/LIQ-04.png" width="430" alt="LIQ-04 after"></a></td>
</tr></table>

### LIQ-05 · Business processes

**Role:** Business Engineer  
**Finding:** Holds, approvals, running and recently closed workflows stacked on 2,928 px.  
**Change:** Holds stay on top (they need action). Tabs Approvals (count) · Running (count) · Recently closed; long lists in steps of 15.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-05.png"><img src="img/before/LIQ-05.png" width="430" alt="LIQ-05 before"></a></td>
<td valign="top"><a href="img/after/LIQ-05.png"><img src="img/after/LIQ-05.png" width="430" alt="LIQ-05 after"></a></td>
</tr></table>

<table><tr><th>LIQ-05-RUN · Running</th></tr><tr><td valign="top"><a href="img/after/LIQ-05-RUN.png"><img src="img/after/LIQ-05-RUN.png" width="430" alt="LIQ-05-RUN"></a></td></tr></table>

### LIQ-06 · Proposals

**Role:** Business Engineer  
**Finding:** Every proposal ever made in the list; the config repository card always open.  
**Change:** Open/All filter (open by default). The config repository is a folded section, IT view only.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-06.png"><img src="img/before/LIQ-06.png" width="430" alt="LIQ-06 before"></a></td>
<td valign="top"><a href="img/after/LIQ-06.png"><img src="img/after/LIQ-06.png" width="430" alt="LIQ-06 after"></a></td>
</tr></table>

### LIQ-07 · Proposal detail

**Role:** Business Engineer  
**Finding:** Summary, evidence, ontology diff graph and text diff on one page of 2,629 px; where the proposal stood had to be read from the fields.  
**Change:** A lifecycle stepper (Proposed → Validated → Pull request → Reviewed → Merged; a rejection or conflict is marked). Tabs Summary · Ontology changes (count) · Files. The evidence is a folded section.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-07.png"><img src="img/before/LIQ-07.png" width="430" alt="LIQ-07 before"></a></td>
<td valign="top"><a href="img/after/LIQ-07.png"><img src="img/after/LIQ-07.png" width="430" alt="LIQ-07 after"></a></td>
</tr></table>

<table><tr><th>LIQ-07-ONTO · Ontology changes</th></tr><tr><td valign="top"><a href="img/after/LIQ-07-ONTO.png"><img src="img/after/LIQ-07-ONTO.png" width="430" alt="LIQ-07-ONTO"></a></td></tr></table>

### LIQ-08 · Playbooks

**Role:** IT Engineer  
**Finding:** Active runs, ten recent runs and every definition in two long columns (6,720 px).  
**Change:** Tabs Active runs (count) · Recent runs · Playbooks (invalid ones as a badge); definitions in a two-column grid.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-08-top.png"><img src="img/before/LIQ-08-top.png" width="430" alt="LIQ-08 before"></a><br><sub>top 2,700 px of 6,720; <a href="img/before/LIQ-08.png">full page</a></sub></td>
<td valign="top"><a href="img/after/LIQ-08.png"><img src="img/after/LIQ-08.png" width="430" alt="LIQ-08 after"></a></td>
</tr></table>

### LIQ-09 · Event log

**Role:** IT Engineer  
**Finding:** 200 events in one table (8,116 px).  
**Change:** Same filters, 25 rows per page.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-09-top.png"><img src="img/before/LIQ-09-top.png" width="430" alt="LIQ-09 before"></a><br><sub>top 2,700 px of 8,116; <a href="img/before/LIQ-09.png">full page</a></sub></td>
<td valign="top"><a href="img/after/LIQ-09.png"><img src="img/after/LIQ-09.png" width="430" alt="LIQ-09 after"></a></td>
</tr></table>

### LIQ-10 · Apps

**Role:** Business Engineer  
**Finding:** The registration form (nine fields, folder picker, SDK link) always open below the app cards.  
**Change:** “Register app” in the header opens a four-step dialog: Describe → Permissions → Upload → Check, with Back/Next; a failed check marks the last step.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/LIQ-10.png"><img src="img/before/LIQ-10.png" width="430" alt="LIQ-10 before"></a></td>
<td valign="top"><a href="img/after/LIQ-10.png"><img src="img/after/LIQ-10.png" width="430" alt="LIQ-10 after"></a></td>
</tr></table>

<table><tr><th>LIQ-10-REG · Registration, step 1</th></tr><tr><td valign="top"><a href="img/after/LIQ-10-REG.png"><img src="img/after/LIQ-10-REG.png" width="430" alt="LIQ-10-REG"></a></td></tr></table>

### AGT-01 · Agent chat

**Role:** People working with the agent  
**Finding:** One task.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AGT-01.png"><img src="img/before/AGT-01.png" width="430" alt="AGT-01 before"></a></td>
<td valign="top"><a href="img/after/AGT-01.png"><img src="img/after/AGT-01.png" width="430" alt="AGT-01 after"></a></td>
</tr></table>

### AGT-02 · Tasks

**Role:** People working with the agent  
**Finding:** One list with filters.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AGT-02.png"><img src="img/before/AGT-02.png" width="430" alt="AGT-02 before"></a></td>
<td valign="top"><a href="img/after/AGT-02.png"><img src="img/after/AGT-02.png" width="430" alt="AGT-02 after"></a></td>
</tr></table>

### AGT-03 · Task detail

**Role:** People working with the agent  
**Finding:** Conversation, activity timeline, steps and commits stacked; the instructions as a long card beside them; the lifecycle only as a status chip.  
**Change:** A lifecycle stepper (Requested → Plan → Approval → Run → Verify → Result; Approval only when the plan needs one; an ended task is marked at the step it reached). Tabs Conversation · Activity (timeline and steps) · Commits. The instructions are folded, with a one-line preview.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AGT-03.png"><img src="img/before/AGT-03.png" width="430" alt="AGT-03 before"></a></td>
<td valign="top"><a href="img/after/AGT-03.png"><img src="img/after/AGT-03.png" width="430" alt="AGT-03 after"></a></td>
</tr></table>

<table><tr><th>AGT-03-ACT · Activity</th></tr><tr><td valign="top"><a href="img/after/AGT-03-ACT.png"><img src="img/after/AGT-03-ACT.png" width="430" alt="AGT-03-ACT"></a></td></tr></table>

### AGT-04 · Timeline

**Role:** People working with the agent  
**Finding:** One chart.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AGT-04.png"><img src="img/before/AGT-04.png" width="430" alt="AGT-04 before"></a></td>
<td valign="top"><a href="img/after/AGT-04.png"><img src="img/after/AGT-04.png" width="430" alt="AGT-04 after"></a></td>
</tr></table>

### AGT-05 · Schedules

**Role:** People working with the agent  
**Finding:** One list.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AGT-05.png"><img src="img/before/AGT-05.png" width="430" alt="AGT-05 before"></a></td>
<td valign="top"><a href="img/after/AGT-05.png"><img src="img/after/AGT-05.png" width="430" alt="AGT-05 after"></a></td>
</tr></table>

### AGT-06 · Signals (agent)

**Role:** People working with the agent  
**Finding:** Not comparable: the before shot shows the Tasks page (the page redirected while the agent status was loading).  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AGT-06.png"><img src="img/before/AGT-06.png" width="430" alt="AGT-06 before"></a></td>
<td valign="top"><a href="img/after/AGT-06.png"><img src="img/after/AGT-06.png" width="430" alt="AGT-06 after"></a></td>
</tr></table>

### AGT-07 · Audit (agent)

**Role:** Auditors  
**Finding:** One list.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AGT-07.png"><img src="img/before/AGT-07.png" width="430" alt="AGT-07 before"></a></td>
<td valign="top"><a href="img/after/AGT-07.png"><img src="img/after/AGT-07.png" width="430" alt="AGT-07 after"></a></td>
</tr></table>

### AGT-08 · Workspace

**Role:** People working with the agent  
**Finding:** One file browser.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AGT-08.png"><img src="img/before/AGT-08.png" width="430" alt="AGT-08 before"></a></td>
<td valign="top"><a href="img/after/AGT-08.png"><img src="img/after/AGT-08.png" width="430" alt="AGT-08 after"></a></td>
</tr></table>

### APP-01 · App host

**Role:** Anyone  
**Finding:** A list of apps.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/APP-01.png"><img src="img/before/APP-01.png" width="430" alt="APP-01 before"></a></td>
<td valign="top"><a href="img/after/APP-01.png"><img src="img/after/APP-01.png" width="430" alt="APP-01 after"></a></td>
</tr></table>

### APP-02 · Sample app

**Role:** App users  
**Finding:** A generated sample app.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/APP-02.png"><img src="img/before/APP-02.png" width="430" alt="APP-02 before"></a></td>
<td valign="top"><a href="img/after/APP-02.png"><img src="img/after/APP-02.png" width="430" alt="APP-02 after"></a></td>
</tr></table>

### AUTH-01 · Sign-in

**Role:** Anyone  
**Finding:** One form.  
**Change:** No change.

<table><tr><th>Before</th><th>After</th></tr><tr>
<td valign="top"><a href="img/before/AUTH-01.png"><img src="img/before/AUTH-01.png" width="430" alt="AUTH-01 before"></a></td>
<td valign="top"><a href="img/after/AUTH-01.png"><img src="img/after/AUTH-01.png" width="430" alt="AUTH-01 after"></a></td>
</tr></table>

## Not changed on purpose

- **Ontology editor (LIQ-03):** already one task per screen (canvas, filter, side panel), with its own draft → submit
  flow.
- **Agent UI list pages (AGT-01, AGT-02, AGT-04 to AGT-08):** one list or one tool per page, already with filters.
- **Permissions:** the role view hides things; it does not lock them. A Business Engineer can still open an IT page
  by link, and the server applies the same checks as before.
