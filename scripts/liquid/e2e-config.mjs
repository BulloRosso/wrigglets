#!/usr/bin/env node
// M6 check on the running stack (docs/liquid-enterprise-extension.md, exit criteria of M6), with the Git host of
// ADR-0049: proposals are pull requests on Forgejo, the reviewer approves and merges there, the merge is reconciled.
//   - repair creates the config repository from the running platform, without secrets; main is applied, no drift;
//   - a console edit becomes a commit on main with the signed-in admin as author;
//   - an agent proposes an allow-list change through the MCP upstream "config"; it is validated; after approval it takes
//     effect within one reconcile cycle (the gateway lets the call through); a rejected proposal leaves main unchanged;
//     an invalid proposal cannot be approved; a broken policy is caught by opa check before review;
//   - a stack restart with gateway.json and safety-rules.json removed (fresh /data/admin) reproduces the same behaviour;
//   - ontology editor E2/E3: a draft (new class + link) compiles, is submitted as a proposal with an ontology diff.
// Screenshots of the Proposals page (diff graph) and the draft editor. Restores Max's allow-list afterwards.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';
import { docker } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
let s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
const AGENT = 'sofa-max';
// the reviewer account of the local Git host (its password is an extension secret of the control plane)
const secrets = JSON.parse(docker('exec', 'cw-temporal', 'cat', '/data/admin/extensions-secrets.json').stdout || '{}').liquid ?? {};
const FORGE = 'http://localhost:3300/api/v1';
const forge = async (method, p, body, user = 'reviewer', password = secrets.forgejo_reviewer_password) => {
  const init = { method, headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined };
  // a fresh Git host occasionally drops a connection while it indexes: retry network errors (not HTTP errors)
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await fetch(`${FORGE}${p}`, init);
      break;
    } catch (err) {
      if (i >= 4) throw err;
      log(`Git host: ${String(err)} — retrying ${method} ${p}`);
      await sleep(1000 * (i + 1));
    }
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const prStatus = async (sha) => (await forge('GET', `/repos/liquid/config/commits/${sha}/status`)).body?.state;
const glob = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

function agentCall(agent, tool, a) {
  const script = `fetch(process.env.MCP_GATEWAY_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.MCP_GATEWAY_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: process.argv[1] })
    .then(async (r) => { process.stdout.write(await r.text()); }).catch((e) => { console.error(String(e)); process.exit(1); })`;
  const r = docker('exec', `cw-agent-${agent}`, 'node', '-e', script, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: a } }));
  if (r.status !== 0) throw new Error(`${agent} ${tool}: ${r.stderr.trim()}`);
  const out = JSON.parse(r.stdout);
  return { text: out.result?.content?.[0]?.text ?? JSON.stringify(out.error ?? out), isError: !!out.result?.isError || !!out.error };
}
/** Tools the gateway lists for the agent (only allowed ones). */
function agentTools(agent) {
  const script = `fetch(process.env.MCP_GATEWAY_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.MCP_GATEWAY_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    .then(async (r) => { process.stdout.write(await r.text()); }).catch((e) => { console.error(String(e)); process.exit(1); })`;
  const r = docker('exec', `cw-agent-${agent}`, 'node', '-e', script);
  return (JSON.parse(r.stdout).result?.tools ?? []).map((t) => t.name);
}
const signIn = async () => {
  s = new Session();
  await until('admin console', async () => {
    try {
      await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
      return true;
    } catch {
      return undefined;
    }
  }, 180_000, 3000);
};

let original;
const opened = [];
try {
  await signIn();
  // earlier runs provoke refused calls on purpose; the safety rule "tool-denials" may have switched the agent's tools
  // off — resetting a kill switch is a person's action (logged), done here explicitly so the run starts clean
  const ks = (await api('GET', '/killswitch')).state ?? {};
  if (ks.agents?.[AGENT] && ks.agents[AGENT].level !== 'normal') {
    log(`kill switch of ${AGENT} was ${ks.agents[AGENT].level} (${ks.agents[AGENT].reason}): reset by the test operator`);
    await api('PUT', `/agents/${AGENT}/killswitch`, { level: 'normal', reason: 'reset for the e2e run' });
  }
  const st0 = await api('GET', '/liquid/config');
  check('config repository initialised from the running platform; main applied, no drift', st0.initialized && st0.inSync && st0.drift.length === 0, { head: st0.head?.slice(0, 12), files: st0.files.length });
  check('layout: gateway, safety, agents, policies, ontology, OWNERS', ['gateway/upstreams.yaml', 'gateway/allow-lists.yaml', 'safety/rules.yaml', `agents/${AGENT}.yaml`, 'policies/liquid/object.rego', 'policies/liquid/overlays.yaml', 'ontology/sofa/schema.yaml', 'OWNERS.yaml'].every((f) => st0.files.includes(f)));
  // secrets never in the repository: every agent secret and the gateway token, searched in all of history
  const scan = docker('exec', 'cw-temporal', 'node', '-e', `const {execFileSync}=require('child_process');const a=require('/data/admin/agents.json');const v=[...a.agents.flatMap(x=>Object.values(x.secrets||{})),process.env.GATEWAY_TOKEN].filter(x=>typeof x==='string'&&x.length>=12);let hits=0;const revs=execFileSync('git',['--git-dir','/data/liquid/config.git','rev-list','--all']).toString().trim().split('\\n');for(const s of v){try{execFileSync('git',['--git-dir','/data/liquid/config.git','grep','-F','-q','-e',s,...revs]);hits++}catch{}}console.log(JSON.stringify({secrets:v.length,revisions:revs.length,hits}))`);
  const sc = JSON.parse(scan.stdout || '{}');
  check('no secret value in any revision of the repository', scan.status === 0 && sc.hits === 0 && sc.secrets > 0, sc);

  // 1. console edit → commit
  original = (await api('GET', `/agents/${AGENT}/tools`)).allowedTools;
  await api('PUT', `/agents/${AGENT}/tools`, { allowedTools: [...new Set([...original, 'config__*'])] });
  const commit = await until('console commit', async () => {
    const c = await api('GET', '/liquid/config');
    return c.log[0]?.subject === `console: PUT /api/agents/${AGENT}/tools` ? c.log[0] : undefined;
  }, 20_000, 1000);
  check('a console edit becomes a commit with the admin as author', commit.email === env.BOOTSTRAP_ADMIN_EMAIL && /Requested-By: /.test(commit.body), { subject: commit.subject, email: commit.email });

  // 2. the agent reads and proposes through the gateway
  await until('gateway lists config tools', async () => (await api('GET', '/gateway')).tools.some((t) => t.name === 'config__propose_change'), 120_000, 5000);
  const read = await until('agent can read the config', async () => {
    const r = agentCall(AGENT, 'config__read', { path: 'gateway/allow-lists.yaml' });
    return !r.isError ? r : undefined;
  }, 60_000, 3000);
  check('agent reads gateway/allow-lists.yaml through the upstream config', /allowedTools:/.test(read.text) && read.text.includes('config__*'), `${read.text.length} chars`);
  const tools = (await api('GET', '/gateway')).tools.map((t) => t.name);
  // a tool Max may not call (never actually called: the check uses the gateway's tool list and its refusal)
  const target = ['erp__file_incident_report', ...tools].find((t) => tools.includes(t) && /^(erp|crm)__/.test(t) && !original.some((p) => glob(p).test(t)));
  check('a tool Max is not allowed to call', !!target, target);
  const before = agentCall(AGENT, target, {});
  check('before the change the gateway denies it', before.isError && /not allowed|allow-list|denied/i.test(before.text), before.text.slice(0, 100));
  const lines = read.text.split('\n');
  const at = lines.findIndex((l) => l.trim() === `${AGENT}:`);
  const proposed = [...lines.slice(0, at + 1), `    - ${target}`, ...lines.slice(at + 1)].join('\n');
  const prop = JSON.parse(agentCall(AGENT, 'config__propose_change', { title: `${AGENT} may call ${target}`, reason: 'Needs customer data to plan production for confirmed orders.', evidence: `denied: ${before.text.slice(0, 80)}`, changes: [{ path: 'gateway/allow-lists.yaml', content: proposed }] }).text);
  opened.push(prop.id);
  check('agent proposal is validated immediately', prop.valid === true && prop.status === 'pending', { id: prop.id, approvers: prop.approvers });
  const p1 = await api('GET', `/liquid/proposals/${prop.id}`);
  check('proposal: author agent, one file, diff with the new line', p1.author.kind === 'agent' && p1.author.id === AGENT && p1.paths.join() === 'gateway/allow-lists.yaml' && p1.diff.includes(`+    - ${target}`));
  const pr = (await forge('GET', `/repos/liquid/config/pulls/${p1.pr?.number}`)).body;
  check('it is a pull request on the Git host with the required check liquid/validate = success', pr?.state === 'open' && (await prStatus(p1.head)) === 'success', { pr: p1.pr?.url });
  const consoleDecide = await api('POST', `/liquid/proposals/${prop.id}/decide`, { decision: 'approve' }).then(() => 'decided', (e) => String(e));
  check('the console has no decision route: review and merge happen on the Git host only', /404/.test(consoleDecide), consoleDecide.slice(0, 100));

  // 3. invalid proposals cannot be approved; a broken policy is caught by opa check
  const bad = JSON.parse(agentCall(AGENT, 'config__propose_change', { title: 'broken allow-list', reason: 'typo test', changes: [{ path: 'gateway/allow-lists.yaml', content: 'allowedTools: [1\n' }] }).text);
  opened.push(bad.id);
  const badP = await api('GET', `/liquid/proposals/${bad.id}`);
  await forge('POST', `/repos/liquid/config/pulls/${badP.pr.number}/reviews`, { event: 'APPROVED', body: 'looks fine (e2e)' });
  const badMerge = await forge('POST', `/repos/liquid/config/pulls/${badP.pr.number}/merge`, { Do: 'merge' });
  check('an invalid proposal cannot be merged: required check failed (branch protection)', bad.valid === false && (await prStatus(badP.head)) === 'failure' && badMerge.status >= 400, { status: badMerge.status });
  await forge('PATCH', `/repos/liquid/config/pulls/${badP.pr.number}`, { state: 'closed' });
  const common = await api('GET', '/liquid/config/file?path=policies/liquid/common.rego');
  const regoBad = await api('POST', '/liquid/proposals', { title: 'Broken policy (e2e)', reason: 'checks that opa check runs before review', changes: [{ path: 'policies/liquid/common.rego', content: `${common.content}\nbroken if {\n` }] });
  opened.push(regoBad.id);
  const regoCheck = regoBad.validation.checks.find((c) => c.name.startsWith('policies'));
  check('a broken policy fails opa check before anyone reviews it', regoCheck && !regoCheck.ok, regoCheck?.errors?.[0]?.message?.split('\n')[0]);
  await forge('PATCH', `/repos/liquid/config/pulls/${regoBad.pr.number}`, { state: 'closed' });

  if (!args.has('--no-shots')) await shot(`/liquid/proposals/${prop.id}`, 'liquid-proposals', 1300);

  // 4. the reviewer approves and merges on the Git host → webhook → reconcile
  const t0 = Date.now();
  const review = await forge('POST', `/repos/liquid/config/pulls/${p1.pr.number}/reviews`, { event: 'APPROVED', body: 'ok for this tool (e2e)' });
  const merge = await forge('POST', `/repos/liquid/config/pulls/${p1.pr.number}/merge`, { Do: 'merge', merge_message_field: `${p1.title} (proposal ${p1.id})` });
  check('the reviewer (team reviewers, CODEOWNERS) approves and merges on the Git host', review.status < 300 && merge.status < 300, { review: review.status, merge: merge.status });
  const ok = await until('proposal marked approved by the webhook', async () => {
    const x = await api('GET', `/liquid/proposals/${prop.id}`);
    return x.status === 'approved' ? x : undefined;
  }, 30_000, 1000);
  check('the merge arrives as a webhook: proposal approved, decided by the reviewer', ok.decidedBy === 'reviewer', ok.decidedBy);
  await until('allow-list applied', async () => ((await api('GET', `/agents/${AGENT}/tools`)).allowedTools.includes(target) ? true : undefined), 70_000, 1000);
  await until('gateway lists the tool for the agent', async () => (agentTools(AGENT).includes(target) ? true : undefined), 60_000, 2000);
  check(`after approval the gateway offers ${target} to the agent (${Math.round((Date.now() - t0) / 1000)} s)`, agentTools(AGENT).includes(target));
  const status = JSON.parse(agentCall(AGENT, 'config__get_proposal', { id: prop.id }).text);
  check('the agent sees the decision', status.status === 'approved' && status.decidedBy === 'reviewer', status);

  // 5. rejection leaves main unchanged
  const head = (await api('GET', '/liquid/config')).head;
  const rej = JSON.parse(agentCall(AGENT, 'config__propose_change', { title: `${AGENT} may call every tool`, reason: 'convenience', changes: [{ path: 'gateway/allow-lists.yaml', content: proposed.replace(`    - ${target}`, `    - "*"`) }] }).text);
  opened.push(rej.id);
  const rejP = await api('GET', `/liquid/proposals/${rej.id}`);
  await forge('POST', `/repos/liquid/config/issues/${rejP.pr.number}/comments`, { body: 'too broad (e2e)' });
  await forge('PATCH', `/repos/liquid/config/pulls/${rejP.pr.number}`, { state: 'closed' });
  await until('proposal marked rejected', async () => ((await api('GET', `/liquid/proposals/${rej.id}`)).status === 'rejected' ? true : undefined), 30_000, 1000);
  check('rejection leaves main unchanged', (await api('GET', '/liquid/config')).head === head && !(await api('GET', `/agents/${AGENT}/tools`)).allowedTools.includes('*'));

  // 6. ontology editor: draft → validate → proposal with diff graph (rejected afterwards: live apply is M8)
  const dr = await api('POST', '/liquid/ontology/drafts', { domain: 'sofa' });
  await api('POST', `/liquid/ontology/drafts/${dr.id}/ops`, {
    ops: [
      { op: 'add_class', name: 'Carrier', description: 'A logistics company that delivers purchase orders.', identifier: 'id', annotations: { criticality: 'normal', data_class: 'internal', owner: 'head-of-logistics' } },
      { op: 'add_attribute', class: 'Carrier', name: 'name', required: true },
      { op: 'add_link', from: 'PurchaseOrder', attribute: 'carrier', to: 'Carrier' },
    ],
  });
  const v = await api('POST', `/liquid/ontology/drafts/${dr.id}/validate`);
  check('draft compiles; diff: Carrier added, PurchaseOrder changed', v.ok && v.diff?.classes?.Carrier === 'added' && v.diff?.classes?.PurchaseOrder === 'changed', v.diff?.summary);
  const badOp = await api('POST', `/liquid/ontology/drafts/${dr.id}/ops`, { ops: [{ op: 'add_link', from: 'Carrier', attribute: 'x', to: 'Nope' }] }).then(() => 'accepted', (e) => String(e));
  check('an invalid draft operation is rejected', /unknown class Nope/.test(badOp), badOp.slice(0, 80));
  if (!args.has('--no-shots')) await shot(`/liquid/ontology?draft=${dr.id}`, 'liquid-ontology-draft', 900);
  // E4: a minor change needs the minor version (the editor's "Set <version>" button)
  await api('POST', `/liquid/ontology/drafts/${dr.id}/ops`, { ops: [{ op: 'set_version', version: v.compat.suggestedVersion }] });
  const v2 = await api('POST', `/liquid/ontology/drafts/${dr.id}/validate`);
  check('E4: compatibility minor, the suggested version is set', v2.ok && v2.compat?.level === 'minor' && v2.compat.versionOk, v2.compat?.suggestedVersion);
  const op = await api('POST', `/liquid/ontology/drafts/${dr.id}/submit`, { title: 'Carrier for purchase orders', reason: 'Deliveries are late because of carriers, not suppliers; we need to see which carrier delivers.' });
  opened.push(op.id);
  check('submitted as a proposal: compiled, with ontology diff and owners', op.validation.ok && op.irDiff?.classes?.Carrier === 'added' && op.owners.length >= 1, { checks: op.validation.checks.map((c) => `${c.name}=${c.ok}`), owners: op.owners });
  check('the ontology proposal is a pull request too', !!op.pr?.number, op.pr?.url);
  if (!args.has('--no-shots')) await shot(`/liquid/proposals/${op.id}`, 'liquid-proposal-ontology', 1700);
  await forge('PATCH', `/repos/liquid/config/pulls/${op.pr.number}`, { state: 'closed' });

  // 7. exit criterion: fresh gateway/safety stores + restart → same behaviour from the repository
  const want = { tools: (await api('GET', `/agents/${AGENT}/tools`)).allowedTools.slice().sort(), rules: (await api('GET', '/safety/rules')).rules.slice().sort((a, b) => a.id.localeCompare(b.id)) };
  docker('exec', 'cw-temporal', 'sh', '-c', 'mv /data/admin/gateway.json /data/admin/gateway.json.e2e-bak && mv /data/admin/safety-rules.json /data/admin/safety-rules.json.e2e-bak');
  const restartedAt = Date.now();
  docker('restart', 'cw-temporal');
  await sleep(5000);
  await signIn();
  const rec = await until('reconciled after restart', async () => {
    const c = await api('GET', '/liquid/config').catch((e) => (log(`  (waiting: ${String(e).slice(0, 80)})`), undefined));
    return c?.lastReconcile?.ok && c.drift.length === 0 && Date.parse(c.lastReconcile.at) > restartedAt && c.lastReconcile.changes.length ? c : undefined;
  }, 150_000, 3000);
  const got = { tools: (await api('GET', `/agents/${AGENT}/tools`)).allowedTools.slice().sort(), rules: (await api('GET', '/safety/rules')).rules.slice().sort((a, b) => a.id.localeCompare(b.id)) };
  check('restart with empty gateway/safety stores reproduces allow-lists and safety rules from the repository', JSON.stringify(got.tools) === JSON.stringify(want.tools) && JSON.stringify(got.rules) === JSON.stringify(want.rules), rec.lastReconcile.changes.slice(0, 6));
  const cmp = docker('exec', 'cw-temporal', 'node', '-e', "const fs=require('fs');const a=JSON.parse(fs.readFileSync('/data/admin/gateway.json.e2e-bak','utf8')),b=JSON.parse(fs.readFileSync('/data/admin/gateway.json','utf8'));const n=x=>JSON.stringify(x.upstreams.map(u=>({...u,policy:u.policy??'none'})).sort((p,q)=>p.name.localeCompare(q.name)));console.log(JSON.stringify({upstreams:n(a)===n(b),allowedTools:Object.keys(a.allowedTools).every(k=>JSON.stringify([...a.allowedTools[k]].sort())===JSON.stringify([...(b.allowedTools[k]||[])].sort())),limits:JSON.stringify(a.limits)===JSON.stringify(b.limits)}))");
  const same = JSON.parse(cmp.stdout || '{}');
  check('gateway config after the restart equals the one before (upstreams, allow-lists, limits)', same.upstreams && same.allowedTools && same.limits, same);
  docker('exec', 'cw-temporal', 'sh', '-c', 'rm -f /data/admin/gateway.json.e2e-bak /data/admin/safety-rules.json.e2e-bak');
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err);
  log(String(err));
} finally {
  if (original) {
    await api('PUT', `/agents/${AGENT}/tools`, { allowedTools: original }).then(
      () => log(`restored ${AGENT}'s allow-list (console commit)`),
      (e) => log(`could not restore the allow-list: ${e}`),
    );
  }
  result.finishedAt = new Date().toISOString();
  mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/liquid/results/e2e-config.json'), JSON.stringify(result, null, 2));
  log(`${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok`);
  process.exit(result.ok ? 0 : 1);
}

async function shot(url, name, height) {
  const { Shots } = await import('../sofa-company/shots.mjs');
  process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
  const shots = await new Shots(path.join(root, 'docs', 'images', 'liquid')).open();
  await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}${url}`, name, { width: 1500, height, wait: 4000, fullPage: true });
  await shots.close();
  log(`screenshot docs/images/liquid/${name}.png`);
}
