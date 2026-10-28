#!/usr/bin/env node
// Runs the disruption scenarios of docs/agentic-mitigations.md against the REAL agents (real model, gateway, Temporal,
// exfiltration guard) and the mock ERP/CRM, takes screenshots of the real UIs, and approves the plans the way the people
// would: a scripted person signs in, looks at the plan and decides. Prerequisite: scripts/sofa-company/setup.mjs.
//
//   cd scripts/sofa-company && npm install          # once, for the screenshots (playwright-core)
//   node scripts/sofa-company/run.mjs [--only 1,2,3] [--no-shots] [--timeout-min 45]
//
// Results: docs/images/mitigations/*.png and scripts/sofa-company/results/<scenario>.json (plans, decisions, reports,
// KPIs before and after, every change the agents made in ERP/CRM).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, AGENTS, HUMANS, MOCK, PASSWORD, Session, env, log, root, sleep, until } from './lib.mjs';
import { Shots } from './shots.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : a), []));
const TIMEOUT_MS = Number(args['timeout-min'] ?? 45) * 60_000;
const TERMINAL = new Set(['completed', 'rejected', 'cancelled', 'failed', 'budget_exceeded', 'expired']);
const MOCK_HOST = MOCK;

/* ------------------------------------------------------------------ the scenarios: what a person says, how they decide */

const SCENARIOS = [
  {
    n: 1,
    id: 'supplier-beams',
    title: 'A supplier cannot deliver the wood beams for the frames',
    requester: 'stefan',
    agent: 'sofa-lara',
    task: {
      title: 'Nordholz cannot deliver pine beams',
      instructions:
        'Nordholz just told us that they cannot deliver any pine beams before 2026-11-30 (kiln damage), including the two open purchase orders. Our beam stock will not last. Find out how bad it is, secure alternative supply and make sure frame production keeps running. Ask Cora to re-plan production if the new supply does not close the gap, and Horst to take care of customers whose delivery promise is at risk.',
    },
    comments: {
      'sofa-lara': 'Approved. Keep Nordholz\'s postponed orders open, we will not cancel them.',
      'sofa-cora': 'Approved. Protect the tier-A customers first.',
      'sofa-horst': 'Approved. Please keep the notices short and factual.',
    },
  },
  {
    n: 2,
    id: 'machine-failure',
    title: 'A machine in production fails and needs maintenance',
    requester: 'paula',
    agent: 'sofa-max',
    task: {
      title: 'Frame cutter N-CUT-1 in Werk Nord is down',
      instructions:
        'The CNC frame cutter N-CUT-1 in Werk Nord stopped this morning (drive error on the spindle). Get it repaired as fast as possible and keep our deliveries on track: the spare part has to be ordered by Lara, Cora has to re-plan the production orders, and Horst has to inform customers whose delivery promise cannot be kept anymore.',
    },
    comments: {
      'sofa-max': 'Approved. Take the fastest repair path, the cutter is the bottleneck of the whole plant.',
      'sofa-lara': 'Approved. The express surcharge is justified for this part.',
      'sofa-cora': 'Approved.',
      'sofa-horst': 'Approved. Tier-A customers first.',
    },
  },
  {
    n: 3,
    id: 'demand-spike',
    title: 'An ad campaign causes a spike in demand',
    requester: 'sabine',
    agent: 'sofa-horst',
    task: {
      title: 'Autumn campaign: demand far above plan',
      instructions:
        'Our autumn campaign (Herbstzauber) works almost too well: order intake is far above plan and several new sales orders have no production order yet. Make sure we can deliver what we sold without burning out the factories. Decide whether the campaign has to be throttled (do not stop it completely, we still want the sales), ask Cora to plan the new orders, Max to secure capacity, and Lara to secure the material.',
    },
    // a person reads the plan and pushes back once if the agent proposes to stop the campaign
    revise: { agent: 'sofa-horst', when: /pause|stop(ping)? the campaign|0\s*%/i, comment: 'Please do not stop the campaign. Throttle it, but keep at least half of the daily budget running.' },
    comments: {
      'sofa-horst': 'Approved.',
      'sofa-cora': 'Approved.',
      'sofa-max': 'Approved. Overtime only where it is really needed.',
      'sofa-lara': 'Approved.',
    },
  },
  {
    n: 4,
    id: 'sick-leave',
    title: 'Two workers of one factory call in sick for two weeks',
    requester: 'paula',
    agent: 'sofa-max',
    task: {
      title: 'Werk Süd: both workers on sick leave 12-23 October',
      instructions:
        'Lena Hartmann and Tobias Klein, the two workers of Werk Süd, are on sick leave from 2026-10-12 to 2026-10-23. Keep the orders of Werk Süd on time: check the staffing options (temporary workers, overtime) and ask Cora to adjust the schedule, and Horst to inform customers if something cannot be saved.',
    },
    comments: {
      'sofa-max': 'Approved. Temporary workers first, overtime only if needed.',
      'sofa-cora': 'Approved.',
      'sofa-horst': 'Approved.',
    },
  },
  {
    n: 5,
    id: 'storm',
    title: 'A thunderstorm damages most of the upholstery fabric in the warehouse',
    requester: 'stefan',
    agent: 'sofa-tom',
    task: {
      title: 'Storm damage in the fabric hall',
      instructions:
        'The thunderstorm last night damaged the roof of the fabric hall. A surveyor has inspected the affected lots (see the quarantine notes in the ERP). Handle the damaged stock: write off what the surveyor declares unusable, release what is usable, and file the incident report for the insurance. Production must not run out of fabric: ask Lara to buy replacement fabric and Cora to re-prioritise the orders.',
    },
    comments: {
      'sofa-tom': 'Approved. Only the quantities named by the surveyor.',
      'sofa-lara': 'Approved.',
      'sofa-cora': 'Approved.',
    },
  },
];

/* ------------------------------------------------------------------ helpers */

const kpi = async () => (await fetch(`${MOCK_HOST}/kpi`)).json();
const post = (p) => fetch(`${MOCK_HOST}${p}`, { method: 'POST' }).then((r) => r.json());

const admin = new Session();
log('signing in to the admin console');
await admin.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
const registry = await admin.json('GET', `${ADMIN}/api/agents?health=false`);
const baseUrl = Object.fromEntries(Object.keys(AGENTS).map((id) => [id, `http://${process.env.PUBLIC_HOST || env.PUBLIC_HOST || 'localhost'}:${registry.find((a) => a.spec.agentId === id).spec.hostPort}`]));

const sessions = new Map();
async function as(human, agentId) {
  const key = `${human}@${agentId}`;
  if (!sessions.has(key)) {
    const s = new Session();
    await s.signIn(baseUrl[agentId], HUMANS[human].email, PASSWORD);
    sessions.set(key, s);
  }
  return sessions.get(key);
}

const allTasks = async () => (await Promise.all(Object.keys(AGENTS).map(async (id) => (await admin.json('GET', `${ADMIN}/api/tasks?agentId=${id}&limit=100`)).map((t) => ({ ...t, agentId: id }))))).flat();

async function fileText(s, agentId, p) {
  const r = await s.raw(`${baseUrl[agentId]}/api/workspace/file?path=${encodeURIComponent(p)}`);
  return r.ok ? await r.text() : '';
}

async function describeTask(t) {
  const owner = AGENTS[t.agentId].owner;
  const s = await as(owner, t.agentId);
  const d = await s.json('GET', `${baseUrl[t.agentId]}/api/tasks/${t.taskId}`);
  const st = d.state ?? {};
  const plan = st.plan?.path ? await fileText(s, t.agentId, st.plan.path) : '';
  const reports = [];
  for (const f of (st.result?.outputs ?? []).filter((x) => x.startsWith('reports/'))) reports.push({ path: f, text: await fileText(s, t.agentId, f) });
  return {
    agent: AGENTS[t.agentId].name,
    agentId: t.agentId,
    taskId: t.taskId,
    title: st.title,
    status: st.status,
    requestedBy: st.requestedBy?.name,
    trigger: st.trigger,
    decisions: (st.decisions ?? []).map((x) => ({ decision: x.decision, by: x.by?.name, comment: x.comment, kind: x.kind })),
    revisions: st.revisions,
    delegations: (st.delegations ?? []).map((x) => ({ agentId: x.agentId, taskId: x.taskId, state: x.state })),
    steps: (st.steps ?? []).map((x) => ({ kind: x.kind, summary: x.summary, tokens: x.tokens })),
    summary: st.result?.summary,
    plan,
    reports,
    tokens: st.usage?.tokens,
  };
}

/* ------------------------------------------------------------------ one scenario */

/** The agent's wiki (all Markdown files under wiki/), as the agent left it. */
async function wikiSnapshot(agentId) {
  const s = await as(AGENTS[agentId].owner, agentId);
  const files = [];
  const walk = async (dir) => {
    const tree = await s.json('GET', `${baseUrl[agentId]}/api/workspace/tree?path=${encodeURIComponent(dir)}`).catch(() => undefined);
    for (const e of tree?.entries ?? []) {
      if (e.type === 'dir') await walk(e.path);
      else if (e.path.endsWith('.md') && files.length < 60) files.push({ path: e.path, text: (await fileText(s, agentId, e.path)).slice(0, 8000) });
    }
  };
  await walk('wiki');
  return files;
}

async function runScenario(sc, shots, attempt = 1, guardStops = []) {
  const prefix = `${args.prefix ? `${args.prefix}-` : ''}s${sc.n}`;
  let shotNo = 0;
  const shot = async (email, url, name, opts) => {
    if (!shots) return;
    shotNo += 1;
    return shots.snap(email, url, `${prefix}-${String(shotNo).padStart(2, '0')}-${name}`, opts).catch((e) => log(`   screenshot ${name} failed: ${e.message}`));
  };
  const adminMail = env.BOOTSTRAP_ADMIN_EMAIL;

  log(`══ Scenario ${sc.n}: ${sc.title}`);
  await post('/reset');
  const before = await kpi();
  await post(`/scenario/${sc.id}/start`);
  const afterIncident = await kpi();
  log(`   incident injected: ${afterIncident.lateOrders} late orders, ${afterIncident.unplannedOrders.length} unplanned, shortages ${JSON.stringify(afterIncident.materialShortages)}`);
  await sleep(500);
  await shot(adminMail, `${MOCK_HOST}/dashboard`, 'erp-after-incident', { fullPage: true });

  const known = new Set((await allTasks()).map((t) => t.taskId));
  const requester = await as(sc.requester, sc.agent);
  const created = await requester.json('POST', `${baseUrl[sc.agent]}/api/tasks`, { title: sc.task.title, instructions: sc.task.instructions, type: 'change', approval: 'plan' });
  log(`   ${HUMANS[sc.requester].name} → ${AGENTS[sc.agent].name}: task ${created.taskId}`);
  const primaryId = created.taskId;
  await shot(HUMANS[sc.requester].email, `${baseUrl[sc.agent]}/tasks/${primaryId}`, `task-created-${AGENTS[sc.agent].name.toLowerCase()}`, { height: 900 });

  const handled = new Set();
  const delegSeen = new Set();
  const revised = new Set();
  const started = Date.now();
  let quietSince = 0;
  let timedOut = false;
  for (;;) {
    const tasks = (await allTasks()).filter((t) => t.taskId === primaryId || !known.has(t.taskId));
    for (const t of tasks) {
      const name = AGENTS[t.agentId].name;
      const ownerKey = AGENTS[t.agentId].owner;
      const owner = HUMANS[ownerKey];
      if (t.status === 'awaiting_approval' && !handled.has(t.taskId)) {
        handled.add(t.taskId);
        const s = await as(ownerKey, t.agentId);
        const d = await s.json('GET', `${baseUrl[t.agentId]}/api/tasks/${t.taskId}`);
        const plan = d.state?.plan?.path ? await fileText(s, t.agentId, d.state.plan.path) : '';
        log(`   ${name}: plan waiting for ${owner.name} (${t.taskId})`);
        await shot(owner.email, `${baseUrl[t.agentId]}/tasks/${t.taskId}`, `plan-${name.toLowerCase()}`, { height: 1000 });
        await shot(adminMail, `${ADMIN}/mail`, `approval-mail-${name.toLowerCase()}`, {
          before: async (page) => {
            await page.getByText(d.state?.title ?? t.title, { exact: false }).first().click({ timeout: 4000 }).catch(() => undefined);
            await sleep(800);
          },
        });
        await shot(owner.email, `${baseUrl[t.agentId]}/tasks/${t.taskId}?decide=approve`, `decision-dialog-${name.toLowerCase()}`, { height: 1000, wait: 2000 });
        const rv = sc.revise;
        if (rv && rv.agent === t.agentId && !revised.has(t.agentId) && rv.when.test(plan)) {
          revised.add(t.agentId);
          log(`   ${owner.name} requests changes from ${name}`);
          handled.delete(t.taskId); // the revised plan needs a new decision
          await s.json('POST', `${baseUrl[t.agentId]}/api/tasks/${t.taskId}/decision`, { decision: 'revise', comment: rv.comment });
          await shot(owner.email, `${baseUrl[t.agentId]}/tasks/${t.taskId}`, `revision-requested-${name.toLowerCase()}`, { height: 1000, wait: 1500 });
          await until('revised plan', async () => (await admin.json('GET', `${ADMIN}/api/tasks?agentId=${t.agentId}&limit=100`)).find((x) => x.taskId === t.taskId)?.status === 'awaiting_approval', 300_000, 4000).catch(() => undefined);
          continue;
        }
        await s.json('POST', `${baseUrl[t.agentId]}/api/tasks/${t.taskId}/decision`, { decision: 'approve', comment: sc.comments[t.agentId] ?? 'Approved.' });
        log(`   ${owner.name} approved ${name}'s plan`);
      }
      if (t.status === 'awaiting_delegations' && !delegSeen.has(t.taskId)) {
        delegSeen.add(t.taskId);
        await sleep(3000);
        await shot(owner.email, `${baseUrl[t.agentId]}/tasks/${t.taskId}`, `delegating-${name.toLowerCase()}`, { height: 1000 });
      }
    }
    const newAlerts = (await admin.json('GET', `${ADMIN}/api/security/alerts`)).alerts.filter((a) => tasks.some((t) => t.taskId === a.taskId));
    if (newAlerts.length) break; // the guard stopped an agent: handled below
    const active = tasks.filter((t) => !TERMINAL.has(t.status));
    const primary = tasks.find((t) => t.taskId === primaryId);
    if (active.length === 0 && primary && TERMINAL.has(primary.status)) {
      quietSince ||= Date.now();
      if (Date.now() - quietSince > 25_000) break; // no new delegated tasks appeared
    } else quietSince = 0;
    if (Date.now() - started > TIMEOUT_MS) {
      timedOut = true;
      log('   TIMEOUT');
      break;
    }
    await sleep(4000);
  }

  const tasks = (await allTasks()).filter((t) => t.taskId === primaryId || !known.has(t.taskId));
  const alerts = (await admin.json('GET', `${ADMIN}/api/security/alerts`)).alerts.filter((a) => tasks.some((t) => t.taskId === a.taskId));
  if (alerts.length && attempt < 3 && !timedOut) {
    // the exfiltration guard stopped an agent: record it, restore the agents and run the scenario again
    log(`   GUARD STOP: ${alerts.map((a) => `${a.agentId} ${a.category} on ${a.tool}`).join('; ')}`);
    guardStops.push(...alerts.map((a) => ({ attempt, agentId: a.agentId, tool: a.tool, category: a.category, confidence: a.confidence, reason: a.reason, callSummary: a.callSummary })));
    await shots?.snap(adminMail, `${ADMIN}/safety`, `${prefix}-guard-stop-attempt${attempt}`, { height: 1000, wait: 2500 }).catch(() => undefined);
    for (const id of Object.keys(AGENTS)) await admin.json('PUT', `${ADMIN}/api/agents/${id}/killswitch`, { level: 'normal' }).catch(() => undefined);
    for (const t of await allTasks()) {
      if (!TERMINAL.has(t.status) && (t.taskId === primaryId || !known.has(t.taskId))) await (await as(AGENTS[t.agentId].owner, t.agentId).catch(() => undefined))?.raw(`${baseUrl[t.agentId]}/api/tasks/${t.taskId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
    }
    for (const id of Object.keys(AGENTS)) await until(`${id} healthy`, async () => (await (await fetch(`${baseUrl[id]}/health`)).json()).harness?.state === 'up', 240_000, 3000);
    return runScenario(sc, shots, attempt + 1, guardStops);
  }
  // a halted agent is restored first, so that its task and wiki can be read
  for (const id of Object.keys(AGENTS)) await admin.json('PUT', `${ADMIN}/api/agents/${id}/killswitch`, { level: 'normal' }).catch(() => undefined);
  for (const id of Object.keys(AGENTS)) await until(`${id} healthy`, async () => (await (await fetch(`${baseUrl[id]}/health`)).json()).harness?.state === 'up', 240_000, 3000).catch(() => undefined);
  const described = [];
  for (const t of tasks) described.push(await describeTask(t).catch((e) => ({ agent: AGENTS[t.agentId].name, agentId: t.agentId, taskId: t.taskId, title: t.title, status: t.status, error: String(e), decisions: [], delegations: [], steps: [], plan: '', reports: [] })));
  const after = await kpi();
  log(`   result: late orders ${afterIncident.lateOrders} → ${after.lateOrders}, unplanned ${afterIncident.unplannedOrders.length} → ${after.unplannedOrders.length}, cost € ${after.costOfMeasuresEur}`);

  // evidence of the outcome, from the people's point of view
  await shot(adminMail, `${MOCK_HOST}/dashboard`, 'erp-after-mitigation', { fullPage: true });
  for (const d of described) {
    const owner = HUMANS[AGENTS[d.agentId].owner];
    await shot(owner.email, `${baseUrl[d.agentId]}/tasks/${d.taskId}`, `done-${d.agent.toLowerCase()}`, { height: 1100, wait: 2000 });
  }
  const wiki = {};
  for (const d of described) wiki[d.agent] = await wikiSnapshot(d.agentId).catch(() => []);
  const wikiOwner = described.find((d) => (wiki[d.agent] ?? []).length);
  if (wikiOwner) await shot(HUMANS[AGENTS[wikiOwner.agentId].owner].email, `${baseUrl[wikiOwner.agentId]}/workspace/wiki`, `wiki-${wikiOwner.agent.toLowerCase()}`, { height: 900, wait: 2500 });
  const result = { scenario: sc.id, n: sc.n, title: sc.title, request: { by: HUMANS[sc.requester].name, to: AGENTS[sc.agent].name, ...sc.task }, timedOut, attempts: attempt, wiki, guardStops, kpi: { baseline: before, afterIncident, afterMitigation: after }, tasks: described, changes: await (await fetch(`${MOCK_HOST}/log`)).json(), customerNotices: await (await fetch(`${MOCK_HOST}/notices`)).json(), primaryTaskId: primaryId };
  const dir = path.join(root, 'scripts/sofa-company/results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${prefix}-${sc.id}.json`), JSON.stringify(result, null, 2));
  return result;
}

/* ------------------------------------------------------------------ wiki lint: every agent tidies its own wiki */

async function lintWikis(shots) {
  log('══ Wiki lint');
  const known = new Set((await allTasks()).map((t) => t.taskId));
  const started = [];
  for (const [id, a] of Object.entries(AGENTS)) {
    const s = await as(a.owner, id);
    const t = await s.json('POST', `${baseUrl[id]}/api/tasks`, { title: 'Wiki lint', type: 'change', approval: 'none', instructions: 'Lint your wiki as described in your instructions (Lint): fix contradictions, merge duplicates, remove what is stale, repair links and the index, and log what you changed. Report what you changed.' });
    started.push({ id, taskId: t.taskId });
  }
  await until('wiki lint tasks', async () => (await allTasks()).filter((t) => !known.has(t.taskId)).every((t) => TERMINAL.has(t.status)), 25 * 60_000, 6000).catch(() => undefined);
  const out = {};
  for (const { id, taskId } of started) {
    out[AGENTS[id].name] = { task: await describeTask({ agentId: id, taskId }).catch(() => undefined), wiki: await wikiSnapshot(id).catch(() => []) };
    if (shots) await shots.snap(HUMANS[AGENTS[id].owner].email, `${baseUrl[id]}/tasks/${taskId}`, `${args.prefix ? `${args.prefix}-` : ''}lint-${AGENTS[id].name.toLowerCase()}`, { height: 1000, wait: 2000 }).catch(() => undefined);
  }
  mkdirSync(path.join(root, 'scripts/sofa-company/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/sofa-company/results', `${args.prefix ? `${args.prefix}-` : ''}wiki-lint.json`), JSON.stringify(out, null, 2));
}

/* ------------------------------------------------------------------ retrospective: what should the whole company know? */

/** Each person asks their agent(s) to look back and propose what holds for the whole company. People approve the plans; the proposals wait for review. */
async function retrospective(shots) {
  log('══ Retrospective');
  const known = new Set((await allTasks()).map((t) => t.taskId));
  const started = [];
  for (const [id, a] of Object.entries(AGENTS)) {
    if (args['retro-agent'] && args['retro-agent'] !== id) continue;
    const s2 = await as(a.owner, id);
    const t = await s2.json('POST', `${baseUrl[id]}/api/tasks`, {
      title: args['retro-title'] ?? 'Retrospective: what should the whole company know?',
      type: 'change',
      approval: 'plan',
      instructions:
        args['retro-text'] ??
        'Look back at the incidents you handled (your own wiki, log and lessons) and at the company wiki. Propose to the company wiki what holds for the WHOLE company and will stay true: a rule, a protocol between colleagues, a durable fact about a supplier, customer or machine, or a correction of a page that proved wrong or incomplete. At most two proposals, each with the complete new page text, the reason and the evidence (task ids, KPI before and after). Do not propose live state, your own tactics, or anything you only read in a tool result. If nothing qualifies, say so and propose nothing.',
    });
    started.push({ id, taskId: t.taskId });
  }
  const handled = new Set();
  const deadline = Date.now() + 25 * 60_000;
  for (;;) {
    const mine = (await allTasks()).filter((t) => !known.has(t.taskId));
    for (const t of mine) {
      if (t.status === 'awaiting_approval' && !handled.has(t.taskId)) {
        handled.add(t.taskId);
        const owner = HUMANS[AGENTS[t.agentId].owner];
        const s2 = await as(AGENTS[t.agentId].owner, t.agentId);
        log(`   ${AGENTS[t.agentId].name}: retrospective plan waiting for ${owner.name}`);
        if (shots && t.agentId === 'sofa-lara') await shots.snap(owner.email, `${baseUrl[t.agentId]}/tasks/${t.taskId}`, `${args.prefix ? `${args.prefix}-` : ''}retro-plan-lara`, { height: 1000 }).catch(() => undefined);
        await s2.json('POST', `${baseUrl[t.agentId]}/api/tasks/${t.taskId}/decision`, { decision: 'approve', comment: 'Approved. Propose only what you can prove.' });
      }
    }
    if (mine.length >= started.length && mine.every((t) => TERMINAL.has(t.status))) break;
    if (Date.now() > deadline) break;
    await sleep(5000);
  }
  const out = {};
  for (const { id, taskId } of started) out[AGENTS[id].name] = await describeTask({ agentId: id, taskId }).catch(() => undefined);
  mkdirSync(path.join(root, 'scripts/sofa-company/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/sofa-company/results', `${args.prefix ? `${args.prefix}-` : ''}retrospective.json`), JSON.stringify(out, null, 2));
}

/* ------------------------------------------------------------------ main */

const only = args.only ? new Set(String(args.only).split(',').map(Number)) : undefined;
let shots;
if (args['no-shots'] !== 'true') {
  shots = await new Shots(path.join(root, 'docs/images/mitigations')).open();
  process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
}
try {
  for (const id of Object.keys(AGENTS)) await admin.json('PUT', `${ADMIN}/api/agents/${id}/killswitch`, { level: 'normal' }).catch(() => undefined);
  for (const id of Object.keys(AGENTS)) await until(`${id} healthy`, async () => (await (await fetch(`${baseUrl[id]}/health`)).json()).harness?.state === 'up', 240_000, 3000);
  for (const t of await allTasks()) if (!TERMINAL.has(t.status)) await (await as(AGENTS[t.agentId].owner, t.agentId).catch(() => undefined))?.raw(`${baseUrl[t.agentId]}/api/tasks/${t.taskId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  if (shots && !only) {
    await post('/reset');
    await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${MOCK_HOST}/dashboard`, 's0-erp-baseline', { fullPage: true });
  }
  const order = args.order ? String(args.order).split(',').map(Number) : SCENARIOS.map((x) => x.n);
  for (const n of order) {
    const sc = SCENARIOS.find((x) => x.n === n);
    if (!sc || (only && !only.has(n))) continue;
    await runScenario(sc, shots);
  }
  if (args.lint === 'true') await lintWikis(shots);
  if (args.retro === 'true') await retrospective(shots);
  if (shots) {
    const prefix = args.prefix ? `${args.prefix}-` : '';
    await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/wiki`, `${prefix}company-wiki-proposals`, { height: 1300, wait: 3500 }).catch(() => undefined);
  }
} finally {
  await shots?.close();
}
log('done');
