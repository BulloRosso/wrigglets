#!/usr/bin/env node
// M5 check on the running stack (docs/liquid-enterprise-extension.md, exit criteria of M5):
//   - repair installs the business worker; the bootstrap step creates namespace `business` with its search attributes;
//   - create_purchase_order (starts_workflow in the ontology) starts a PurchaseOrderRelease workflow per order;
//   - holding Supplier:S-NORDHOLZ pauses exactly the workflows that touch it; the others release on time;
//   - a worker restart loses nothing (holds survive, no duplicate starts, events after the restart are dispatched);
//   - releasing the hold resumes the held workflows (the orders get released);
//   - a four-eyes request (ActionApprovalRequested) becomes an ApprovalWorkflow; a person approves in the console and the
//     action runs with approvedBy (and its purchase order starts its own PurchaseOrderRelease).
// Screenshot of the Business processes page for the docs. Leaves erp/crm on the mock afterwards.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';

const args = new Set(process.argv.slice(2));
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
const ONTO = 'cw-ext-liquid-ontology-server';
// the business worker runs inside the enterprise core since ADR-0049
const WORKER = 'cw-ext-liquid-ontology-server';

/** Calls the ontology server's REST API from inside its container (internal token). */
function onto(method, p, body) {
  const script = `fetch('http://127.0.0.1:7710' + process.argv[1], { method: process.argv[2], headers: { authorization: 'Bearer ' + process.env.INTERNAL_TOKEN, 'content-type': 'application/json' }, body: process.argv[3] || undefined })
    .then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }))).catch((e) => { console.error(String(e)); process.exit(1); })`;
  const r = docker('exec', ONTO, 'node', '-e', script, p, method, body ? JSON.stringify(body) : '');
  if (r.status !== 0) throw new Error(`${method} ${p}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}
const createPo = (supplierId, quantity) => {
  const r = onto('POST', '/actions/create_purchase_order', { supplierId, sku: 'BEAM-PINE-80', quantity, _requestedBy: 'e2e-processes' });
  if (r.status !== 200) throw new Error(`create_purchase_order ${supplierId}: ${JSON.stringify(r.body)}`);
  return JSON.parse(r.body.result).id;
};
const po = (id) => onto('GET', `/objects/PurchaseOrder/${id}`).body;
const releaseOf = (row) => row?.released_at ?? row?.releasedAt ?? null;

/** MCP tools/call as an agent, from inside its container, through the gateway. */
function agentCall(agent, tool, a) {
  const script = `fetch(process.env.MCP_GATEWAY_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.MCP_GATEWAY_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: process.argv[1] })
    .then(async (r) => { process.stdout.write(await r.text()); }).catch((e) => { console.error(String(e)); process.exit(1); })`;
  const r = docker('exec', `cw-agent-${agent}`, 'node', '-e', script, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: a } }));
  if (r.status !== 0) throw new Error(`${agent} ${tool}: ${r.stderr.trim()}`);
  const out = JSON.parse(r.stdout);
  return { text: out.result?.content?.[0]?.text ?? JSON.stringify(out.error ?? out), isError: !!out.result?.isError || !!out.error };
}

const runningFor = (procs, poId) => procs.running.find((p) => p.type === 'PurchaseOrderRelease' && p.objects.includes(`PurchaseOrder:${poId}`));
let swapped = false;
try {
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  await api('POST', '/extensions/liquid/repair', {});
  const st = await until('repair finished', async () => {
    const x = await api('GET', '/extensions/liquid');
    if (x.phase === 'failed') throw new Error(JSON.stringify(x.operation.steps.filter((y) => y.error)));
    return x.phase === 'installed' && x.operation?.finishedAt && x.available ? x : undefined;
  }, 300_000, 3000);
  check('repair: all services running (business worker inside the enterprise core)', st.services.every((x) => x.state === 'running') && !st.services.some((x) => x.name === 'business-worker'), st.services.map((x) => `${x.name}=${x.state}`));
  check('bootstrap step business-namespace ran', st.operation.steps.some((x) => x.id === 'bootstrap:business-namespace' && x.state === 'done'));
  await until('worker dispatching', async () => /business worker running/.test(docker('logs', WORKER).stdout + docker('logs', WORKER).stderr) || undefined, 180_000, 3000);
  const first = await api('GET', '/liquid/processes');
  check('processes API answers (namespace business reachable)', Array.isArray(first.running), `${first.running.length} running`);

  // 1. purchase orders start PurchaseOrderRelease workflows
  await api('POST', '/liquid/sim/reset');
  const nord = [createPo('S-NORDHOLZ', 3000), createPo('S-NORDHOLZ', 4000)];
  const baltic = createPo('S-BALTIC', 2000);
  log(`created ${nord.join(', ')} (S-NORDHOLZ) and ${baltic} (S-BALTIC)`);
  const started = await until('three PurchaseOrderRelease workflows', async () => {
    const p = await api('GET', '/liquid/processes');
    return [...nord, baltic].every((id) => runningFor(p, id)) ? p : undefined;
  }, 30_000, 1000);
  check('create_purchase_order starts one PurchaseOrderRelease per order', [...nord, baltic].every((id) => runningFor(started, id)?.objects.includes('Material:BEAM-PINE-80')), [...nord, baltic].map((id) => runningFor(started, id).workflowId));

  // 2. hold by supplier pauses exactly those
  const hold = await api('POST', '/liquid/processes/hold', { objects: ['Supplier:S-NORDHOLZ'], reason: 'Supplier under review (e2e)' });
  const nordWf = nord.map((id) => runningFor(started, id).workflowId).sort();
  check('hold on Supplier:S-NORDHOLZ reaches exactly its workflows', JSON.stringify(hold.workflows) === JSON.stringify(nordWf), hold.workflows);
  await until(`${baltic} released after the release window`, async () => releaseOf(po(baltic)) || undefined, 90_000, 2000);
  await sleep(3000);
  check('the other supplier\'s order is released on time; the held ones are not', !!releaseOf(po(baltic)) && nord.every((id) => !releaseOf(po(id))), { [baltic]: releaseOf(po(baltic)), ...Object.fromEntries(nord.map((id) => [id, releaseOf(po(id))])) });
  const held = await api('GET', '/liquid/processes');
  check('held workflows report BusinessState held', nord.every((id) => runningFor(held, id)?.hold?.held && runningFor(held, id)?.state === 'held'), nord.map((id) => runningFor(held, id)?.state));

  // 3. approval workflow: four-eyes request from an agent (erp on the ontology server with OPA)
  const swap = spawnSync(process.execPath, [path.join(root, 'scripts/liquid/setup.mjs'), '--opa'], { encoding: 'utf8' });
  swapped = true;
  check('erp/crm point at the ontology server with policy: opa', swap.status === 0, swap.stdout.trim().split('\n')[0] || swap.stderr);
  await until('gateway lists erp tools', async () => (await api('GET', '/gateway')).tools.some((t) => t.name === 'erp__create_purchase_order'), 120_000, 5000);
  const ask = agentCall('sofa-lara', 'erp__create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 1500 });
  check('payment-critical write outside an approved task waits for four eyes', ask.isError && /^Pending approval/.test(ask.text), ask.text.slice(0, 100));
  const approval = await until('ApprovalWorkflow running', async () => (await api('GET', '/liquid/processes')).running.find((p) => p.type === 'ApprovalWorkflow' && p.approval?.request.caller.agent === 'sofa-lara' && p.approval.request.args.quantity === 1500), 30_000, 1000);
  check('the request became an ApprovalWorkflow', approval.approval.state === 'pending', { workflowId: approval.workflowId, objects: approval.objects });

  if (!args.has('--no-shots')) {
    const { Shots } = await import('../sofa-company/shots.mjs');
    process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
    process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
    const shots = await new Shots(path.join(root, 'docs', 'images', 'liquid')).open();
    await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid/processes`, 'liquid-processes', { width: 1400, height: 1200, wait: 3000, fullPage: true });
    await shots.close();
    log('screenshot docs/images/liquid/liquid-processes.png');
  }

  // 4. worker restart: holds survive, nothing is started twice, new events are dispatched
  const before = (await api('GET', '/liquid/processes')).running.filter((p) => p.type === 'PurchaseOrderRelease').length;
  docker('restart', WORKER);
  await until('worker back', async () => /business worker running/.test(docker('logs', '--since', '60s', WORKER).stdout + docker('logs', '--since', '60s', WORKER).stderr) || undefined, 120_000, 2000);
  const after = await until('queries answer after restart', async () => {
    const p = await api('GET', '/liquid/processes');
    return nord.every((id) => runningFor(p, id)?.hold) ? p : undefined;
  }, 60_000, 2000);
  check('after a worker restart the holds are still in place and no workflow was started twice', nord.every((id) => runningFor(after, id).hold.held) && after.running.filter((p) => p.type === 'PurchaseOrderRelease').length === before, { before, after: after.running.filter((p) => p.type === 'PurchaseOrderRelease').length });
  const late = createPo('S-BALTIC', 1200);
  const lateP = await until('order created after the restart is dispatched', async () => runningFor(await api('GET', '/liquid/processes'), late), 30_000, 1000);
  check('events after the restart are dispatched', !!lateP, lateP.workflowId);

  // 5. approve in the console (signed-in person) → the action runs with approvedBy
  const decided = await api('POST', `/liquid/approvals/${encodeURIComponent(approval.workflowId)}/decide`, { decision: 'approve', comment: 'e2e' });
  check('approval accepted (decided by the signed-in person)', decided.decision?.decision === 'approve' && decided.decision.by === env.BOOTSTRAP_ADMIN_EMAIL, decided.decision);
  const done = await until('approval executed', async () => {
    const p = await api('GET', '/liquid/processes');
    return p.recent.find((x) => x.workflowId === approval.workflowId && x.status === 'COMPLETED');
  }, 60_000, 2000);
  const evt = docker('exec', 'cw-ext-liquid-ontology-db', 'psql', '-U', 'onto', '-d', 'onto', '-tAc', "SELECT object_id || '|' || coalesce(payload->>'approvedBy','') FROM events WHERE type = 'PurchaseOrderCreated' AND actor_agent = 'sofa-lara' ORDER BY seq DESC LIMIT 1").stdout.trim();
  check('the approved action ran with approvedBy (event committed)', !!done && evt.endsWith(`|${env.BOOTSTRAP_ADMIN_EMAIL}`), evt);
  const approvedPo = evt.split('|')[0];
  await until('approved order starts its PurchaseOrderRelease', async () => runningFor(await api('GET', '/liquid/processes'), approvedPo), 30_000, 1000);
  check('the approved purchase order started its own PurchaseOrderRelease', true, approvedPo);
  const twice = await api('POST', `/liquid/approvals/${encodeURIComponent(approval.workflowId)}/decide`, { decision: 'reject' }).then(() => false, () => true);
  check('a second decision is refused', twice);

  // 6. release resumes the held workflows
  const rel = await api('POST', '/liquid/processes/release', { ref: hold.ref });
  check('release reaches the held workflows', JSON.stringify(rel.workflows) === JSON.stringify(nordWf), rel.workflows);
  await until('held orders released', async () => nord.every((id) => releaseOf(po(id))) || undefined, 30_000, 1000);
  check('released workflows resume: the orders get released', nord.every((id) => releaseOf(po(id))), Object.fromEntries(nord.map((id) => [id, releaseOf(po(id))])));

  // 7. the lake flush runs as a Temporal schedule
  const lake = await until('lake flushed by the schedule', async () => {
    const l = await api('GET', '/liquid/lake');
    return l.lastFlush && Date.now() - Date.parse(l.lastFlush.at) < 150_000 ? l : undefined;
  }, 150_000, 5000);
  check('lake-flush schedule flushes the event log into the lake', !!lake, lake.lastFlush);
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err);
  log(String(err));
} finally {
  if (swapped) {
    const back = spawnSync(process.execPath, [path.join(root, 'scripts/liquid/setup.mjs'), '--restore'], { encoding: 'utf8' });
    log(back.status === 0 ? 'erp/crm restored to the mock' : `restore failed: ${back.stderr}`);
  }
  result.finishedAt = new Date().toISOString();
  mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/liquid/results/e2e-processes.json'), JSON.stringify(result, null, 2));
  log(`${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok`);
  process.exit(result.ok ? 0 : 1);
}
