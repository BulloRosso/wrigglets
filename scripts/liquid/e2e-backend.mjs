#!/usr/bin/env node
// M3 check on the running stack (docs/liquid-enterprise-extension.md): the ontology server is the backend of the sofa
// agents. An agent calls erp/crm tools THROUGH THE GATEWAY (its own token, from inside its container), the writes become
// events with the agent as actor, the KPI equals the mock's for the same steps, the projection rebuilt from the event
// log is identical, and the generated data-quality checks pass on the live projection.
//
//   node scripts/liquid/e2e-backend.mjs [--keep-onto]   (default: erp/crm stay on the ontology server afterwards)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, until } from '../sofa-company/lib.mjs';
import { mockControl, SERVERS } from '../sofa-company/mock-mcp.mjs';

const AGENT = 'sofa-lara';
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);

/** An MCP call as the agent, from inside its container, through the gateway (stateless JSON responses). */
function agentCall(tool, args) {
  const script = `fetch(process.env.MCP_GATEWAY_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.MCP_GATEWAY_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: process.argv[1] })
    .then(async (r) => { const t = await r.text(); if (!r.ok) { console.error(r.status + ' ' + t); process.exit(1); } process.stdout.write(t); })
    .catch((e) => { console.error(String(e)); process.exit(1); })`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  const r = spawnSync('docker', ['exec', `cw-agent-${AGENT}`, 'node', '-e', script, body], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${tool}: ${r.stderr.trim()}`);
  const out = JSON.parse(r.stdout);
  if (out.error) throw new Error(`${tool}: ${JSON.stringify(out.error)}`);
  return { text: out.result.content?.[0]?.text ?? '', isError: !!out.result.isError };
}
const mockCall = (tool, args) => {
  const t = Object.values(SERVERS).flatMap((x) => x.tools).find((x) => x.name === tool);
  const o = t.run(structuredClone(args));
  return { text: o.content[0].text, isError: !!o.isError };
};
const psql = (sql) => spawnSync('docker', ['exec', 'cw-ext-liquid-ontology-db', 'psql', '-U', 'onto', '-d', 'onto', '-tAc', sql], { encoding: 'utf8' }).stdout.trim();

try {
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  await api('POST', '/extensions/liquid/repair', {});
  const st = await until('repair finished', async () => {
    const x = await api('GET', '/extensions/liquid');
    if (x.phase === 'failed') throw new Error(JSON.stringify(x.operation.steps.filter((y) => y.error)));
    return x.phase === 'installed' && x.operation?.finishedAt && x.available ? x : undefined;
  }, 300_000, 3000);
  check('repair applied the new image and registered the owned upstream onto', st.upstreams.includes('onto'), st.upstreams);

  const swap = spawnSync(process.execPath, [path.join(root, 'scripts/liquid/setup.mjs')], { encoding: 'utf8' });
  check('erp/crm now point at the ontology server', swap.status === 0, swap.stdout.trim().split('\n').slice(0, 2).join(' | ') || swap.stderr);
  const tools = await until('gateway lists the ontology tools', async () => {
    const t = (await api('GET', '/gateway')).tools.map((x) => x.name);
    return t.filter((n) => n.startsWith('onto__')).length === 31 && t.filter((n) => /^(erp|crm)__/.test(n)).length === 31 ? t : undefined;
  }, 120_000, 5000);
  check('the gateway lists 31 onto__ and 31 erp__/crm__ tools from the ontology server', true, { onto: tools.filter((n) => n.startsWith('onto__')).length });

  // same steps against the mock (in-process) and the ontology server (via the gateway, as the agent)
  await api('POST', '/liquid/sim/reset');
  mockControl.reset();
  await api('POST', '/liquid/sim/scenario/supplier-beams/start');
  mockControl.scenario('supplier-beams');
  const before = Number(psql('SELECT count(*) FROM events'));
  const steps = [
    ['erp__list_suppliers', { sku: 'BEAM-PINE-80' }],
    ['erp__create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 6000, express: true, note: 'bridge Nordholz outage' }],
    ['erp__create_purchase_order', { supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', quantity: 3000 }],
    ['erp__get_kpi', {}],
  ];
  const answers = [];
  for (const [tool, args] of steps) {
    const viaGateway = agentCall(tool, args);
    const viaMock = mockCall(tool.replace(/^(erp|crm)__/, ''), args);
    answers.push({ tool, equal: viaGateway.text === viaMock.text, isError: viaGateway.isError });
    check(`${tool} through the gateway answers like the mock`, viaGateway.text === viaMock.text && viaGateway.isError === viaMock.isError, viaGateway.isError ? viaGateway.text.slice(0, 80) : `${viaGateway.text.length} chars`);
  }
  const written = Number(psql('SELECT count(*) FROM events')) - before;
  check('exactly one event written (read-only and failed precondition write nothing)', written === 1, `${written} new event(s)`);
  const ev = psql("SELECT type || '|' || object_id || '|' || coalesce(actor_agent,'') || '|' || coalesce(action,'') || '|' || jsonb_array_length(payload->'changes') FROM events ORDER BY seq DESC LIMIT 1");
  check('the event records the agent the gateway verified, the action and its changes', ev === `PurchaseOrderCreated|PO-4430|${AGENT}|create_purchase_order|1`, ev);
  const kpi = await api('GET', '/liquid/sim/kpi');
  check('KPI equals the mock after the same steps', JSON.stringify(kpi) === JSON.stringify(mockControl.kpi()), { lateOrders: kpi.lateOrders, cost: kpi.costOfMeasuresEur });

  const dry = await api('POST', '/liquid/projection/rebuild?dryRun=true');
  check('projection rebuilt from T0 + the whole event log is identical (row hash)', dry.identical, { events: dry.eventsApplied, hash: dry.rebuilt.slice(0, 12) });
  const dq = await api('GET', '/liquid/projection/dq');
  check('generated data-quality checks pass on the live projection', dq.passed, `${dq.checks} checks, ${dq.failed.length} failed`);
  const flushed = spawnSync('docker', ['exec', 'cw-ext-liquid-ontology-server', 'node', '-e', "fetch('http://127.0.0.1:7710/internal/lake/flush',{method:'POST',headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(r=>r.text()).then(console.log)"], { encoding: 'utf8' }).stdout.trim();
  const inLake = (await api('GET', '/liquid/lake')).hwm;
  check('action events reach the lake (flush)', inLake === Number(psql('SELECT max(seq) FROM events')), { flush: flushed, hwm: inLake });
  result.answers = answers;
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err?.message ?? err);
  log(`ERROR ${result.error}`);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/liquid/results/m3-backend-e2e.json'), JSON.stringify(result, null, 2));
  log(`result: scripts/liquid/results/m3-backend-e2e.json (${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok)`);
}
