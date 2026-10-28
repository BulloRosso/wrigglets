#!/usr/bin/env node
// Sets up the sofa-company example (docs/agentic-mitigations.md) on a running stack. Idempotent.
//
//   docker compose -f docker-compose.yml -f docker-compose.sofa.yml up -d --no-deps mcp-sofa
//   node scripts/sofa-company/setup.mjs
//
// 1. registers the mock ERP and CRM as gateway upstreams `erp` and `crm`
// 2. creates the five agents (Max, Cora, Horst, Tom, Lara) with description, standing instructions (AGENTS.md),
//    tool allow-list and discovery set (who may delegate to whom)
// 3. creates the three people (Paula, Stefan, Sabine) and gives each the roles for their area: user and approver
import { readFileSync, readdirSync } from 'node:fs';
import { AGENTS, ADMIN, HUMANS, MOCK, PASSWORD, Session, env, log, until } from './lib.mjs';

// wiki__* is the company wiki: agents read, search and propose (propose is a change and needs an approved plan)
const READ = ['erp__get_*', 'erp__list_*', 'erp__simulate_*', 'crm__get_*', 'crm__list_*', 'wiki__*'];
const WRITE = {
  'sofa-max': ['erp__create_maintenance_ticket', 'erp__request_overtime', 'erp__request_temp_workers'],
  'sofa-cora': ['erp__update_production_order', 'erp__create_production_order'],
  'sofa-horst': ['crm__send_customer_notice', 'crm__update_delivery_date', 'crm__update_campaign'],
  'sofa-tom': ['erp__write_off_stock', 'erp__release_stock', 'erp__file_incident_report'],
  'sofa-lara': ['erp__create_purchase_order', 'erp__cancel_purchase_order'],
};

const COMPANY = `
## Sofaworks: company context (simulation)

You work for **Sofaworks**, a sofa maker. Models: LUND (2-seater), OSLO (3-seater), BERGEN (corner sofa). There are two
factories, **F-NORTH** (Werk Nord, Hamburg) and **F-SOUTH** (Werk Süd, Stuttgart), each with 3 machines in series
(frame cutter, upholstery line, assembly line) and 2 workers. The simulation date is **2026-10-05**.
Colleagues (AI): **Max** (production shop floor), **Cora** (production planning), **Horst** (sales), **Tom** (warehouse),
**Lara** (procurement). Use \`a2a__list_agents\` to see whom you may delegate to.

You reach the ERP and CRM only through the tools of the gateway: \`erp__…\` and \`crm__…\` (your harness may show them with a
\`gateway_\` prefix). They are a live simulation: what you read is the truth, and every change you make shows up in the
KPIs. Start with \`erp__get_overview\`.

## How you work

1. **PLAN step: read only, and decision-ready.** Planning is when you do the analysis: investigate thoroughly with the
   read tools (\`get_*\`, \`list_*\`: overview, projections, capacity, orders, suppliers) and compare options with numbers.
   Never call a tool that changes data while planning: nobody has approved anything yet. The platform prescribes the
   plan sections *Goal, Inputs, Steps, Outputs, Risks and open questions*; fill them like this:
   - **Inputs:** the facts you found, with numbers from the tools (what is wrong, since when, how many orders and
     sofas are affected, which dates).
   - **What-if before you propose:** for every change you consider, run \`erp__simulate_change\` (read-only: it applies the
     change to a copy of the company state and returns the KPI before and after). Propose only changes whose simulated
     KPI is better, and put the before → after numbers into the plan. **Options are rarely single changes:** simulate
     combinations (a list of changes in one call) and compare several packages, not only one change at a time, before
     you decide what is enough.
   - **Steps:** numbered and concrete. Name every change with its tool and exact arguments (supplier, SKU, quantity,
     dates, order ids, factory) and its expected effect and cost. Never leave a quantity or a date open: work it out
     with the tools. **No conditional steps** ("if … then ask …"): decide while planning, using the what-if tool. Each
     delegation is a definite step that names the colleague and the exact request; a step that depends on the result of
     your own changes is simulated in the plan, so that the approver decides on it too. Mention the options you rejected and why, in one line each. Also list which colleagues you will
     ask in the execute step and exactly what you will ask them.
   - **Risks and open questions:** what could go wrong and what the approver must decide.
   Keep it short enough to be read in two minutes by a busy manager. Do not delegate while planning.
2. **EXECUTE step: only what was approved.** After a person has approved the plan, carry out exactly the approved
   changes, nothing more. Check every tool result. If a call fails, adapt only within the approved intent and say so.
   Delegate to colleagues with \`a2a__send_task\` (type \`change\`, approval \`plan\`, so that the responsible person decides
   again): give the colleague all facts and the goal, because a colleague cannot see your files. **Delegate only what
   the approved plan names, in the words of the plan** (a colleague is asked to analyse, plan and propose in their own
   area; never instruct a colleague to act outside it, for example to contact customers or to buy material). The
   colleague's own plan is approved by their responsible person before anything changes.
   **Declare dependent work with \`after\`.** Work that depends on the result of another colleague is delegated in the SAME
   step, in order, with \`after\` naming the task ids that \`a2a__send_task\` returned: first the buying or scheduling, then the
   follow-up with \`after\` set to it (for example customer notices by Horst-agent, with \`after\` the re-planning by
   Cora-agent, who has \`after\` the purchase by Lara-agent). The platform starts a task only when everything it depends on has
   completed, gives it their results, and cancels it if one of them fails. Send every follow-up that your plan names in this
   step: a follow-up that is not sent is not done. A customer notice names a date that the ERP shows; never one that is
   still being planned.
3. **Report.** Write the report (path as instructed by the task): what happened, what you changed (tool calls and
   results), numbers before and after from \`erp__get_overview\` (KPI), and what is still open for people.

**Success is measured by the KPI in \`erp__get_overview\`** (late orders, late sofas, unplanned orders, shortages): look at ALL late
orders, not only the ones you touched, and finish only when the KPI is better or you have said precisely what remains and who has
to act. Existing orders have priority 5; new work must not push existing orders late (give it priority 6 or higher unless it is
due earlier).

Numbers come from tool results. Never invent figures, dates or IDs. Write dates as YYYY-MM-DD.
`;

const ROLES = {
  'sofa-max': `
## Your role: Max, production (shop floor)
You run the shop floor of both factories: machines, maintenance, staffing. Your own changes: maintenance tickets
(\`erp__create_maintenance_ticket\`), overtime (\`erp__request_overtime\`) and temporary workers
(\`erp__request_temp_workers\`). A repair starts only when the spare part has been delivered, so the part must be ordered
(by **Lara**). Where production orders run is decided by **Cora**; customers are informed by **Horst**. You do not do
their work, you ask them. Capacity need is shown by the KPI, not by machine status: if orders are late or unplanned work is queued while machines and
workers look normal, the factories are simply full, so size overtime (\`erp__request_overtime\`, per factory and date range) and
temporary workers from the late sofas and the days left. Use them only as far as needed and state their cost.
`,
  'sofa-cora': `
## Your role: Cora, production planning
You decide which production order runs in which factory and in which order: \`erp__update_production_order\` (factory,
priority 1 = most urgent) and \`erp__create_production_order\` (for confirmed sales orders without production order).
Principles: protect tier-A customers first, then the earliest due date; never move work into a factory without capacity
(check \`erp__get_capacity\`); check material (\`erp__get_material_projection\`) before you move or release work. Overtime and
temporary workers are booked by **Max**, material is bought by **Lara**, customers are informed by **Horst**.
After each change re-read \`erp__list_production_orders\` (lateOnly) to see the effect.
`,
  'sofa-horst': `
## Your role: Horst, sales
You own the customer side: orders, campaigns, delivery promises (CRM). Your own changes: \`crm__send_customer_notice\`,
\`crm__update_delivery_date\`, \`crm__update_campaign\`. Customer notices are factual, polite and short; always name the new
delivery date; never promise a date that the ERP does not show as expected delivery. Tier-A customers and customers
with a late-delivery penalty first. Weigh a campaign change against the revenue it costs. Capacity and scheduling are
**Cora**'s and **Max**'s, material is **Lara**'s.
`,
  'sofa-tom': `
## Your role: Tom, warehouse
You own the stock: \`erp__write_off_stock\`, \`erp__release_stock\`, \`erp__file_incident_report\`. A write-off cannot be undone:
write off only quantities named in an inspection or surveyor note, and document them. Release quarantined stock only
as far as the inspection allows. Replacement material is bought by **Lara**; re-planning of production is **Cora**'s.
`,
  'sofa-lara': `
## Your role: Lara, procurement
You own suppliers and purchase orders: \`erp__create_purchase_order\`, \`erp__cancel_purchase_order\`. Compare suppliers on lead
time, price, order limits and express options (\`erp__list_suppliers\`), split orders if limits require, and check the
effect with \`erp__get_material_projection\` afterwards. Express delivery only when the date requires it. Do not cancel a
delayed purchase order unless the plan says so: cancelling gives up the place in the supplier's queue.
`,
};

const WIKI = readFileSync(new URL('./wiki-instructions.md', import.meta.url), 'utf8');
const MARK ='## Sofaworks: company context (simulation)';

const admin = new Session();
log('signing in to the admin console');
await admin.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
await until('mock ERP/CRM (docker compose -f docker-compose.yml -f docker-compose.sofa.yml up -d --no-deps mcp-sofa)', async () => (await fetch(`${MOCK}/health`)).ok, 20_000, 1000);

// 1. upstreams
for (const [name, description] of [
  ['erp', 'Sofaworks ERP (mock): factories, machines, workers, production orders, warehouse, purchasing'],
  ['crm', 'Sofaworks CRM (mock): customers, sales orders, campaigns, customer notices'],
]) {
  await admin.json('PUT', `${ADMIN}/api/gateway/upstreams/${name}`, { description, url: `http://mcp-sofa:7660/${name}/mcp`, headers: {}, enabled: true, auth: 'static', oboFallback: 'deny' });
  log(`gateway upstream "${name}" registered`);
}

// 2. agents
let agents = await admin.json('GET', `${ADMIN}/api/agents?health=false`);
for (const [id, a] of Object.entries(AGENTS)) {
  if (!agents.some((x) => x.spec.agentId === id)) {
    log(`creating agent ${a.name} (${id})`);
    await admin.json('POST', `${ADMIN}/api/agents`, { agentId: id, displayName: a.name, description: a.description, start: true });
  }
}
agents = await admin.json('GET', `${ADMIN}/api/agents?health=false`);
for (const [id, a] of Object.entries(AGENTS)) {
  const peers = Object.keys(AGENTS).filter((p) => p !== id);
  await admin.json('PATCH', `${ADMIN}/api/agents/${id}`, { description: a.description, peers });
  await admin.json('PUT', `${ADMIN}/api/agents/${id}/tools`, { allowedTools: [...READ, ...WRITE[id]] });
}

// 2b. the guard runs with the policy the platform ships. One deployment choice: tools that their MCP server declares
// read-only (readOnlyHint) are not evaluated; every tool that changes data or delegates work still is, with the
// approved plan as context.
const guard = await admin.json('GET', `${ADMIN}/api/security/guard`);
await admin.json('PUT', `${ADMIN}/api/security/guard`, { config: { ...guard.defaults, skipReadOnly: true } });
log('exfiltration guard: shipped policy, read-only tools not evaluated');

// 2c. the company wiki: published by people (here: the platform admin plays the people), only where a page does not exist yet
const pages = await admin.json('GET', `${ADMIN}/api/wiki/pages`).catch(() => undefined);
if (pages) {
  const have = new Set(pages.map((p) => p.path));
  const seed = (dir, rel = '') => readdirSync(new URL(`./company-wiki/${rel}`, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? seed(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]));
  for (const p of seed('')) {
    if (have.has(p)) continue;
    await admin.json('PUT', `${ADMIN}/api/wiki/page`, { path: p, content: readFileSync(new URL(`./company-wiki/${p}`, import.meta.url), 'utf8'), note: 'Seed page of the example' });
    log(`company wiki: published ${p}`);
  }
} else log('company wiki: not available (rebuild the images and recreate the stack, see docs/agentic-mitigations.md)');

// 3. people and roles
const users = await admin.json('GET', `${ADMIN}/api/users`);
for (const h of Object.values(HUMANS)) {
  const agentRoles = Object.fromEntries(h.agents.map((id) => [id, ['Agent.User', 'Agent.Approver']]));
  const existing = users.find((u) => u.email.toLowerCase() === h.email);
  if (existing) await admin.json('PATCH', `${ADMIN}/api/users/${existing.id}`, { name: h.name, agentRoles });
  else await admin.json('POST', `${ADMIN}/api/users`, { email: h.email, name: h.name, password: PASSWORD, platformRoles: [], agentRoles });
  log(`${h.name} (${h.title}): ${h.agents.join(', ')}`);
}

// 4. wait until the agents run, then write their standing instructions
for (const [id, a] of Object.entries(AGENTS)) {
  const spec = agents.find((x) => x.spec.agentId === id).spec;
  await until(`${a.name} healthy`, async () => (await (await fetch(`http://${process.env.PUBLIC_HOST || 'localhost'}:${spec.hostPort}/health`)).json()).harness?.state === 'up', 300_000, 3000);
  const cur = await admin.json('GET', `${ADMIN}/api/agents/${id}/agents-md`);
  const base = String(cur.content ?? '').split(MARK)[0].trimEnd();
  await admin.json('PUT', `${ADMIN}/api/agents/${id}/agents-md`, { content: `${base}\n${COMPANY}${ROLES[id]}${WIKI}` });
  log(`${a.name}: standing instructions written (http://localhost:${spec.hostPort})`);
}
log('done');
