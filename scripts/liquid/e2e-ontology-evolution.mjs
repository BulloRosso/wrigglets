#!/usr/bin/env node
// M8 check on the running stack (exit criterion): adding a class and a link (the D3 change: Carrier, PurchaseOrder.carrier,
// list/create/assign actions) goes from an agent's proposal to live in one reconcile cycle after approval — new tools
// visible to agents through the gateway, the projection migrated, the SDK regenerated, events carrying the new version.
// Then the change is reverted as a breaking change with a migration note (projection rebuilt from the events, live).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';
import { docker, sql } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
// ADR-0049: proposals are pull requests on the Git host; the reviewer approves and merges there (webhook → reconcile)
const approve = async (id, comment) => {
  // the pull request may be opened by the next reconcile if the host was busy
  const p = await until('the proposal has its pull request', async () => {
    const x = await api('GET', `/liquid/proposals/${id}`);
    return x.pr ? x : undefined;
  }, 90_000, 2000);
  const secrets = JSON.parse(docker('exec', 'cw-temporal', 'cat', '/data/admin/extensions-secrets.json').stdout || '{}').liquid ?? {};
  const headers = { authorization: `Basic ${Buffer.from(`reviewer:${secrets.forgejo_reviewer_password}`).toString('base64')}`, 'content-type': 'application/json' };
  const call = async (path, body) => {
    const r = await fetch(`http://localhost:3300/api/v1/repos/liquid/config${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (r.status >= 300) throw new Error(`Forgejo ${path} → ${r.status} ${await r.text()}`);
  };
  await call(`/pulls/${p.pr.number}/reviews`, { event: 'APPROVED', body: comment });
  await call(`/pulls/${p.pr.number}/merge`, { Do: 'merge', merge_message_field: `${p.title} (proposal ${p.id})` });
};
const AGENT = 'sofa-lara'; // procurement: the role the new carrier actions are granted to
const bump = (v, level) => {
  const [a, b] = v.split('.').map(Number);
  return level === 'major' ? `${a + 1}.0.0` : `${a}.${b + 1}.0`;
};

function call(agent, method, params) {
  // the request goes through stdin: ontology files are larger than a Windows command line allows
  const script = `let b = ''; process.stdin.on('data', (c) => (b += c)).on('end', () => fetch(process.env.MCP_GATEWAY_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.MCP_GATEWAY_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: b })
    .then(async (r) => { process.stdout.write(await r.text()); }).catch((e) => { console.error(String(e)); process.exit(1); }))`;
  const r = spawnSync('docker', ['exec', '-i', `cw-agent-${agent}`, 'node', '-e', script], { encoding: 'utf8', input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${agent} ${method}: ${r.error ?? r.stderr}`);
  return JSON.parse(r.stdout);
}
const tool = (name, a) => {
  const out = call(AGENT, 'tools/call', { name, arguments: a });
  return { text: out.result?.content?.[0]?.text ?? JSON.stringify(out.error ?? out), isError: !!out.result?.isError || !!out.error };
};
const agentTools = () => (call(AGENT, 'tools/list', {}).result?.tools ?? []).map((t) => t.name);
function onto(p, body) {
  const script = `let b = ''; process.stdin.on('data', (c) => (b += c)).on('end', () => fetch('http://127.0.0.1:7710' + process.argv[1], { method: 'POST', headers: { authorization: 'Bearer ' + process.env.INTERNAL_TOKEN, 'content-type': 'application/json' }, body: b })
    .then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }))).catch((e) => { console.error(String(e)); process.exit(1); }))`;
  return JSON.parse(spawnSync('docker', ['exec', '-i', 'cw-ext-liquid-ontology-server', 'node', '-e', script, p], { encoding: 'utf8', input: JSON.stringify(body), env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).stdout);
}
const file = async (p) => (await api('GET', `/liquid/config/file?path=${p}`)).content;

let original;
try {
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  original = (await api('GET', `/agents/${AGENT}/tools`)).allowedTools;
  await api('PUT', `/agents/${AGENT}/tools`, { allowedTools: [...new Set([...original, 'config__*', 'onto__list_carriers', 'onto__create_carrier'])] });
  await until('gateway lists config__validate', async () => (await api('GET', '/gateway')).tools.some((t) => t.name === 'config__validate'), 120_000, 5000);
  let live0 = await api('GET', '/liquid/ontology');
  if (live0.classes.some((c) => c.name === 'Carrier')) {
    // a previous run left the D3 change live: remove it first (breaking, with a note), like the end of this script
    log('Carrier is live from an earlier run: reverting first');
    await revertCarriers(live0.version);
    live0 = await api('GET', '/liquid/ontology');
  }
  const schema0 = await file('ontology/sofa/schema.yaml');
  const actions0 = await file('ontology/sofa/actions.yaml');
  const roles0 = await file('policies/liquid/roles/data.json');
  check('the running ontology', true, `${live0.name}@${live0.version}, ${live0.classes.length} classes, ${live0.actions.length} actions`);

  // D3 change as the modelling agent would make it
  const v1 = bump(live0.version, 'minor');
  const schema1 = schema0
    .replace(/^version: .*$/m, `version: ${v1}`)
    .replace(/(\n {2}PurchaseOrder:\n(?:.*\n)*? {4}attributes:\n)/, `$1      carrier: { range: Carrier, description: Logistics company that delivers the order (D3) }\n`)
    .replace(/\nclasses:\n/, `\nclasses:\n  Carrier:\n    description: A logistics company that delivers purchase orders to our warehouse (D3).\n    annotations: { criticality: normal, data_class: internal, owner: head-of-logistics }\n    attributes:\n      id: { identifier: true, description: e.g. CA-001 }\n      name: { required: true }\n\n`);
  const actions1 = actions0
    .replace(/(\n {2}- \{ name: PurchaseOrderReleased[^\n]*\n)/, `$1  - { name: CarrierCreated, object_type: Carrier, description: A carrier was added }\n  - { name: PurchaseOrderCarrierAssigned, object_type: PurchaseOrder, description: The carrier of a purchase order was set }\n`)
    .concat(`  - name: list_carriers\n    target: Carrier\n    kind: query\n    read_only: true\n    description: Carriers that deliver our purchase orders.\n    input:\n      name: { range: string, description: Filter by name }\n  - name: create_carrier\n    target: Carrier\n    kind: create\n    description: WRITE. Add a carrier.\n    input:\n      name: { range: string, required: true, description: Name }\n    emits: [CarrierCreated]\n  - name: assign_carrier\n    target: PurchaseOrder\n    kind: update\n    description: WRITE. Set the carrier that delivers a purchase order.\n    input:\n      poId: { range: PurchaseOrder, required: true, description: Purchase order id }\n      carrierId: { range: Carrier, required: true, description: Carrier id }\n    emits: [PurchaseOrderCarrierAssigned]\n`);
  const rolesDoc = JSON.parse(roles0);
  rolesDoc.roles.procurement.writes = [...new Set([...rolesDoc.roles.procurement.writes, 'create_carrier', 'assign_carrier'])];
  const changes = [
    { path: 'ontology/sofa/schema.yaml', content: schema1 },
    { path: 'ontology/sofa/actions.yaml', content: actions1 },
    // new write actions need a role that may write them (fail closed otherwise): granted in the same reviewed change
    { path: 'policies/liquid/roles/data.json', content: JSON.stringify(rolesDoc, null, 2) + String.fromCharCode(10) },
  ];
  const v = JSON.parse(tool('config__validate', { changes }).text);
  check('config__validate: compiles, compatibility minor, existing data fits, policy tests pass', v.valid && v.compatibility?.level === 'minor' && v.checks.some((c) => c.name.startsWith('policies') && c.ok), { checks: v.checks.map((c) => `${c.name}=${c.ok}`), diff: v.diff?.summary });
  const prop = JSON.parse(tool('config__propose_change', { title: 'Carriers for purchase orders (D3)', reason: 'Late deliveries depend on the carrier, not only the supplier; we need to record which carrier delivers each order.', evidence: JSON.stringify(v.diff), changes }).text);
  check('the agent proposes the extension; validated, compatibility minor', prop.valid && prop.compatibility?.level === 'minor', { id: prop.id, version: v1 });
  const p1 = await api('GET', `/liquid/proposals/${prop.id}`);
  check('the review shows the ontology diff (Carrier added, PurchaseOrder changed)', p1.irDiff?.classes?.Carrier === 'added' && p1.irDiff?.classes?.PurchaseOrder === 'changed');
  if (!args.has('--no-shots')) await shot(`/liquid/proposals/${prop.id}`, 'liquid-proposal-d3', 1900);

  // approve → live in one reconcile
  const t0 = Date.now();
  await approve(prop.id, 'agreed with logistics');
  const live1 = await until('ontology live', async () => {
    const o = await api('GET', '/liquid/ontology');
    return o.version === v1 ? o : undefined;
  }, 90_000, 1000);
  check(`live in ${Math.round((Date.now() - t0) / 1000)} s: ontology ${live1.version}, class Carrier, actions present`, live1.classes.some((c) => c.name === 'Carrier') && ['list_carriers', 'create_carrier', 'assign_carrier'].every((n) => live1.actions.some((a) => a.name === n)));
  const versions = await api('GET', '/liquid/ontology/versions');
  check('the version is recorded as minor', versions[0].version === v1 && versions[0].level === 'minor', versions.slice(0, 2).map((x) => `${x.version}:${x.level}`));
  await until('gateway offers the new tools', async () => ((await api('GET', '/gateway')).tools.some((t) => t.name === 'onto__create_carrier') ? true : undefined), 60_000, 2000);
  check('the gateway offers the new tools', true, 'onto__list_carriers, onto__create_carrier, onto__assign_carrier');
  const at = agentTools();
  check('the agent sees the new tools it is allowed', at.includes('onto__list_carriers') && at.includes('onto__create_carrier'), at.filter((x) => x.includes('carrier')));
  const sdkText = await (await s.raw(`${ADMIN}/api/liquid/ontology/sdk`)).text();
  check('the SDK is regenerated from the new version', typeof sdkText === 'string' && sdkText.includes('Carrier') && sdkText.includes(v1), sdkText ? `${sdkText.length} chars` : 'no sdk');

  // the new actions work (generic, no code): the agent creates a carrier (OPA knows the action after one bundle poll)
  const created = await until('create_carrier allowed', async () => {
    const r = tool('onto__create_carrier', { name: 'Nordfracht Logistik' });
    return r.isError && /unknown action|Denied/.test(r.text) ? undefined : r;
  }, 60_000, 3000);
  check('the agent creates a carrier through the new tool', !created.isError, created.text.slice(0, 80));
  const carrierId = JSON.parse(created.text).id;
  const po = JSON.parse(onto('/actions/list_purchase_orders', {}).body.result)[0];
  const assigned = onto('/actions/assign_carrier', { poId: po.id, carrierId, _requestedBy: 'e2e-ontology-evolution' });
  check('assign_carrier links a purchase order', assigned.status === 200, assigned.body.result?.slice(0, 80));
  check('the projection has the new table and column', sql(`SELECT carrier FROM projection.purchase_order WHERE id = '${po.id}'`) === carrierId && sql(`SELECT name FROM projection.carrier WHERE id = '${carrierId}'`) === 'Nordfracht Logistik');
  check('events carry the new ontology version', sql(`SELECT ontology_version FROM events WHERE type = 'CarrierCreated' ORDER BY seq DESC LIMIT 1`) === v1);
  const rb = await api('POST', '/liquid/projection/rebuild?dryRun=true');
  check('the projection is still exactly the event log replayed', rb.identical === true, { events: rb.eventsApplied });
  if (!args.has('--no-shots')) await shot('/liquid/ontology', 'liquid-ontology-d3', 1000);

  // revert: breaking change with a migration note → rebuild, live
  const v2 = await revertCarriers(v1, { schema0, actions0, roles0 });
  const live2 = await api('GET', '/liquid/ontology');
  const vs = await api('GET', '/liquid/ontology/versions');
  check('the breaking change went live by rebuilding the projection', live2.version === v2 && !live2.classes.some((c) => c.name === 'Carrier') && vs[0].level === 'major' && sql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'projection' AND table_name = 'carrier'") === '0', { version: v2, note: vs[0].note });
  check('history is kept: the carrier events are still in the log', Number(sql("SELECT count(*) FROM events WHERE type = 'CarrierCreated'")) >= 1);
  const back = await until('gateway drops the carrier tools', async () => ((await api('GET', '/gateway')).tools.some((t) => t.name === 'onto__create_carrier') ? undefined : true), 60_000, 2000);
  check('the tools of the removed actions are gone', back);
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err);
  log(String(err));
} finally {
  if (original) await api('PUT', `/agents/${AGENT}/tools`, { allowedTools: original }).catch(() => undefined);
  result.finishedAt = new Date().toISOString();
  mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/liquid/results/e2e-ontology-evolution.json'), JSON.stringify(result, null, 2));
  log(`${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok`);
  process.exit(result.ok ? 0 : 1);
}

/** Removes the D3 change again: a breaking change (major) with a migration note, proposed by the agent, approved. */
async function revertCarriers(current, base) {
  const schemaNow = await file('ontology/sofa/schema.yaml');
  const actionsNow = await file('ontology/sofa/actions.yaml');
  const rolesNow = JSON.parse(await file('policies/liquid/roles/data.json'));
  const v2 = bump(current, 'major');
  const NL = String.fromCharCode(10);
  // without a base: cut the D3 additions out of the current files (line by line, no fragile regexes)
  const lines = schemaNow.split(NL);
  const out = [];
  for (let k = 0; k < lines.length; k++) {
    if (lines[k] === '  Carrier:') {
      while (k + 1 < lines.length && (lines[k + 1].startsWith('    ') || lines[k + 1] === '')) k++;
      continue;
    }
    if (lines[k].startsWith('      carrier: { range: Carrier')) continue;
    out.push(lines[k]);
  }
  const schema = (base?.schema0 ?? out.join(NL)).replace(/^version: .*$/m, `version: ${v2}`);
  const aLines = actionsNow.split(NL);
  const aOut = [];
  for (let k = 0; k < aLines.length; k++) {
    if (/^ {2}- \{ name: (CarrierCreated|PurchaseOrderCarrierAssigned)/.test(aLines[k])) continue;
    if (/^ {2}- name: (list_carriers|create_carrier|assign_carrier)$/.test(aLines[k])) {
      while (k + 1 < aLines.length && aLines[k + 1].startsWith('    ')) k++;
      continue;
    }
    aOut.push(aLines[k]);
  }
  const actions = base?.actions0 ?? aOut.join(NL);
  rolesNow.roles.procurement.writes = rolesNow.roles.procurement.writes.filter((x) => !['create_carrier', 'assign_carrier'].includes(x));
  const roles = base?.roles0 ?? JSON.stringify(rolesNow, null, 2) + NL;
  const revert = [
    { path: 'ontology/sofa/schema.yaml', content: schema },
    { path: 'ontology/sofa/actions.yaml', content: actions },
    { path: 'policies/liquid/roles/data.json', content: roles },
  ];
  const noNote = JSON.parse(tool('config__validate', { changes: revert }).text);
  check('a breaking change without a migration note is invalid', !noNote.valid && noNote.compatibility?.level === 'major', noNote.checks.filter((c) => !c.ok).map((c) => c.name));
  const p = JSON.parse(tool('config__propose_change', { title: 'Remove carriers again (e2e)', reason: 'test of the breaking-change path', migration_note: 'Carrier objects stay in the event log; the projection is rebuilt without them.', changes: revert }).text);
  check('with a migration note it validates', p.valid, p.problems);
  await approve(p.id, 'e2e revert');
  await until('reverted live', async () => ((await api('GET', '/liquid/ontology')).version === v2 ? true : undefined), 120_000, 2000);
  return v2;
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
