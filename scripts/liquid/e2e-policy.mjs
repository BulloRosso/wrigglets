#!/usr/bin/env node
// M4 check on the running stack (docs/liquid-enterprise-extension.md, exit criteria of M4):
//   - with policy: opa on erp/crm, the agents' allowed calls still work (policies reproduce the allow-lists);
//   - an agent outside its role is denied by OPA even when its allow-list is widened;
//   - an overlay denying an action takes effect within 30 s without restarting anything, and removing it restores;
//   - four eyes at the ontology server for an agent write on a payment-critical object outside an approved task;
//   - since ADR-0049 the policy is embedded: the gateway and the enterprise core evaluate the same package (Rego → WASM)
//     in-process; the package endpoint needs a token; denials are events in the event log.
// Screenshot of the Policies page for the docs. Leaves erp/crm on the mock afterwards (--keep-onto to keep them).
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

/** MCP tools/call as an agent, from inside its container, through the gateway. */
function agentCall(agent, tool, a) {
  const script = `fetch(process.env.MCP_GATEWAY_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.MCP_GATEWAY_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: process.argv[1] })
    .then(async (r) => { process.stdout.write(await r.text()); }).catch((e) => { console.error(String(e)); process.exit(1); })`;
  const r = docker('exec', `cw-agent-${agent}`, 'node', '-e', script, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: a } }));
  if (r.status !== 0) throw new Error(`${agent} ${tool}: ${r.stderr.trim()}`);
  const out = JSON.parse(r.stdout);
  return { text: out.result?.content?.[0]?.text ?? JSON.stringify(out.error ?? out), isError: !!out.result?.isError || !!out.error };
}

let restoreTools;
let overlayId;
try {
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  await api('POST', '/extensions/liquid/repair', {});
  const st = await until('repair finished', async () => {
    const x = await api('GET', '/extensions/liquid');
    if (x.phase === 'failed') throw new Error(JSON.stringify(x.operation.steps.filter((y) => y.error)));
    return x.phase === 'installed' && x.operation?.finishedAt && x.available ? x : undefined;
  }, 300_000, 3000);
  check('all services running, no OPA container (policy embedded)', st.services.every((x) => x.state === 'running') && !st.services.some((x) => x.name === 'opa'), st.services.map((x) => `${x.name}=${x.state}`));
  // agents that earlier runs pushed over the tool-denial threshold get their kill switch reset (a person's action)
  const ks = (await api('GET', '/killswitch')).state ?? {};
  for (const a of ['sofa-max', 'sofa-horst', 'sofa-lara']) if (ks.agents?.[a] && ks.agents[a].level !== 'normal') await api('PUT', `/agents/${a}/killswitch`, { level: 'normal', reason: 'reset for the e2e run' });
  const pol = await until('gateway and core loaded the policy package', async () => {
    const p = await api('GET', '/liquid/policy');
    return p.consumers?.gateway && p.consumers?.core && p.consumers.gateway.revision === p.bundle?.revision ? p : undefined;
  }, 90_000, 3000);
  check('gateway and enterprise core load the same compiled policy (WASM) from the control plane', pol.bundle.engine === 'wasm' && pol.consumers.core.revision === pol.bundle.revision, { revision: pol.bundle.revision, files: pol.bundle.files });
  const anon = await fetch(`${ADMIN}/internal/liquid/policy`);
  check('the policy package needs a token', anon.status === 401, anon.status);

  const swap = spawnSync(process.execPath, [path.join(root, 'scripts/liquid/setup.mjs'), '--opa'], { encoding: 'utf8' });
  check('erp/crm point at the ontology server with policy: opa', swap.status === 0 && /policy: opa/.test(swap.stdout), swap.stdout.trim().split('\n').slice(0, 2).join(' | ') || swap.stderr);
  await until('gateway lists erp tools', async () => (await api('GET', '/gateway')).tools.some((t) => t.name === 'erp__get_kpi'), 120_000, 5000);
  await api('POST', '/liquid/sim/reset');

  // 1. allowed calls still work (reads for everyone; Lara's write as in her role)
  const read = agentCall('sofa-horst', 'erp__list_suppliers', { sku: 'BEAM-PINE-80' });
  check('a read through gateway + embedded policy works', !read.isError, `${read.text.length} chars`);
  const write = agentCall('sofa-max', 'erp__request_overtime', { factory: 'F-NORTH', from: '2026-10-06', to: '2026-10-07' });
  check("a write in the agent's role works (production → request_overtime)", !write.isError, write.text.slice(0, 80));

  // 2. widen Horst's allow-list to a procurement write: the gateway's own check passes, OPA denies by role
  const before = (await api('GET', '/agents/sofa-horst/tools')).allowedTools;
  restoreTools = before;
  await api('PUT', '/agents/sofa-horst/tools', { allowedTools: [...before, 'erp__create_purchase_order'] });
  await sleep(3000);
  const outside = agentCall('sofa-horst', 'erp__create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 });
  check('an agent outside its role is denied by the policy although its allow-list was widened', outside.isError && /Denied by policy: .*no role that may run create_purchase_order/.test(outside.text), outside.text.slice(0, 120));
  await api('PUT', '/agents/sofa-horst/tools', { allowedTools: before });
  restoreTools = undefined;

  // 3. an overlay takes effect within 30 s, removing it restores
  const t0 = Date.now();
  const ov = await api('POST', '/liquid/policy/overlays', { effect: 'deny', reason: 'e2e: upstream erp under review', match: { upstreams: ['erp'], actions: ['get_kpi'] } });
  overlayId = ov.id;
  const blocked = await until('overlay effective', async () => {
    const r = agentCall('sofa-max', 'erp__get_kpi', {});
    return r.isError && /overlay/.test(r.text) ? r : undefined;
  }, 30_000, 2000);
  check(`an overlay denying an action takes effect within 30 s (${Math.round((Date.now() - t0) / 1000)} s)`, !!blocked, blocked.text.slice(0, 100));
  const other = agentCall('sofa-max', 'erp__list_machines', {});
  check('other actions are unaffected by the overlay', !other.isError);
  await api('DELETE', `/liquid/policy/overlays/${ov.id}`);
  overlayId = undefined;
  const back = await until('overlay removed', async () => (agentCall('sofa-max', 'erp__get_kpi', {}).isError ? undefined : true), 30_000, 2000);
  check('removing the overlay (a person, audited) restores the call', back);

  // 4. four eyes at the ontology server: agent write on a payment-critical object outside an approved task
  const fourEyes = agentCall('sofa-lara', 'erp__cancel_purchase_order', { poId: 'PO-4418', reason: 'e2e' });
  // no task context: the gateway's OPA already denies destructive actions without an approved plan
  check('destructive action without an approved plan is denied at the gateway', fourEyes.isError && /needs an approved plan/.test(fourEyes.text), fourEyes.text.slice(0, 100));
  const po = agentCall('sofa-lara', 'erp__create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 });
  check('payment-critical write outside an approved task waits for four eyes (ontology server)', po.isError && /^Pending approval \(four eyes\)/.test(po.text), po.text.slice(0, 110));
  const pending = docker('exec', 'cw-ext-liquid-ontology-db', 'psql', '-U', 'onto', '-d', 'onto', '-tAc', "SELECT count(*) FROM events WHERE type = 'ActionApprovalRequested' AND actor_agent = 'sofa-lara'").stdout.trim();
  check('the approval request is recorded as an event', Number(pending) >= 1, `${pending} request(s)`);

  // 5. decisions are events: the gateway's denials (forwarded) and the core's object-level denials
  await sleep(8000); // the event feed forwards the gateway's audit every 5 s
  const decisions = (await api('GET', '/liquid/policy')).decisions;
  check('policy decisions are in the event log (gateway and core)', decisions.some((d) => d.allow === false), `${decisions.length} decisions, e.g. ${decisions.find((d) => d.allow === false)?.reason ?? ''}`.slice(0, 140));

  if (!args.has('--no-shots')) {
    await api('POST', '/liquid/policy/overlays', { effect: 'require_four_eyes', reason: 'Example: supplier data under review', match: { classes: ['Supplier'] }, source: 'admin (docs example)' }).then(async (o) => {
      const { Shots } = await import('../sofa-company/shots.mjs');
      process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
      process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
      const shots = await new Shots(path.join(root, 'docs', 'images', 'liquid')).open();
      await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid/policies`, 'liquid-policies', { width: 1400, height: 1100, wait: 2500, fullPage: true });
      await shots.close();
      await api('DELETE', `/liquid/policy/overlays/${o.id}`);
      log('screenshot docs/images/liquid/liquid-policies.png');
    });
  }
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err?.message ?? err);
  log(`ERROR ${result.error}`);
  process.exitCode = 1;
} finally {
  if (restoreTools) await api('PUT', '/agents/sofa-horst/tools', { allowedTools: restoreTools }).catch(() => undefined);
  if (overlayId) await api('DELETE', `/liquid/policy/overlays/${overlayId}`).catch(() => undefined);
  if (!args.has('--keep-onto')) spawnSync(process.execPath, [path.join(root, 'scripts/liquid/setup.mjs'), '--restore'], { encoding: 'utf8' });
  // the next suite must not meet a tightening of this one: wait until gateway and core run the current package
  await until('policy converged (gateway and core on the current package)', async () => {
    const st = await api('GET', '/liquid/policy');
    const rev = st.bundle?.revision;
    return rev && st.overlays.length === 0 && ['gateway', 'core'].every((c) => st.consumers?.[c]?.revision === rev) ? true : undefined;
  }, 60_000, 1000).catch((err) => log(`warning: ${String(err)}`));
  result.finishedAt = new Date().toISOString();
  mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/liquid/results/m4-policy-e2e.json'), JSON.stringify(result, null, 2));
  log(`result: scripts/liquid/results/m4-policy-e2e.json (${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok)`);
}
