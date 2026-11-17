#!/usr/bin/env node
// D3 — New business requirement (M10, plan §2): "Purchase orders for high-risk commodities need a valid supplier
// due-diligence statement before release." The modelling agent proposes the ontology change with a shadow replay of
// the rule as evidence, the owner approves on the Git host, the reconciler applies it live; the app SDK changes and
// the sample app is re-registered; a new purchase order waits in PurchaseOrderRelease v2 until a buyer submits the
// statement in the app, then it is released; an order that was already in flight finishes on v1.
//
// What is real: platform, ontology pipeline, Temporal (v2 with patched()), Git host, app host. What is scripted: the
// agent's part (its MCP tool calls through the gateway — no model), the reviewer, the buyer's clicks (API calls of the
// app with the buyer's session). Shipped as code: the named check and the v2 wait step; the ontology switches them on.
import { HUMANS, PASSWORD, Session, env } from '../sofa-company/lib.mjs';
import { registerApp } from './app-register.mjs';
import { ADMIN, adminSession, agentTool, calm, core, gitHost, grantTools, log, policyConverged, results, sleep, sql, until } from './lib.mjs';

const R = results('d3-business');
const { check, metric } = R;
const AGENT = 'sofa-lara'; // procurement; plays the modelling agent through its config tools
const SKU = 'BEAM-PINE-80'; // pine beams: timber is a high-risk commodity (deforestation regulation)
const NEW_SUPPLIER = 'S-NORDHOLZ'; // has no statement yet
const PRE = 'due_diligence_for_high_risk_material';
// the rule as ontology data (ADR-0053): a declarative check the release names in its preconditions — no code
const CHECK = {
  subject: { class: 'PurchaseOrder', input: 'poId' },
  when: { path: 'sku.commodity_risk', equals: 'high' },
  require: { exists: { class: 'DueDiligenceStatement', where: { supplier: { path: 'supplier' }, sanctions_checked: { equals: true } } } },
  message: '{subject.id} needs a valid due-diligence statement of supplier {subject.supplier} before release: {subject.sku} is a high-risk commodity',
};
const CHECK_YAML = [
  'checks:',
  `  ${PRE}:`,
  '    description: Purchase orders for high-risk commodities need a valid supplier due-diligence statement before release (D3).',
  '    subject: { class: PurchaseOrder, input: poId }',
  '    when: { path: sku.commodity_risk, equals: high }',
  '    require: { exists: { class: DueDiligenceStatement, where: { supplier: { path: supplier }, sanctions_checked: { equals: true } } } }',
  `    message: "${CHECK.message}"`,
  '',
].join('\n');
const APPS = `http://${env.PUBLIC_HOST || 'localhost'}:8090`;
const APP_ID = 'supplier-due-diligence';
const APP = `${APPS}/apps/${APP_ID}`;
const STEFAN = HUMANS.stefan;
const NL = String.fromCharCode(10);
const bump = (v) => {
  const [a, b] = v.split('.').map(Number);
  return `${a}.${b + 1}.0`;
};
let restoreTools;

try {
  const { api } = await adminSession();
  await calm(api);
  const file = async (p) => agentTool(AGENT, 'config__read', { path: p }).text; // the file as the agent reads it
  const porState = async (poId) => {
    const p = await api('GET', '/liquid/processes');
    return p.running.find((r) => r.type === 'PurchaseOrderRelease' && r.objects.includes(`PurchaseOrder:${poId}`)) ?? p.recent.find((r) => r.type === 'PurchaseOrderRelease' && r.objects.includes(`PurchaseOrder:${poId}`));
  };
  const po = (id) => core('GET', `/objects/PurchaseOrder/${id}`).body;

  // 0. a purchase order already in flight before the change (v1), released before the change goes live
  // re-runnable: a rule left live by an earlier run is taken off the release first (a reviewed change)
  let live0 = await api('GET', '/liquid/ontology');
  if (live0.actions.find((a) => a.name === 'release_purchase_order')?.preconditions?.includes(PRE)) {
    const cfg = async (p) => (await api('GET', `/liquid/config/file?path=${p}`)).content;
    const [a0, b0] = live0.version.split('.').map(Number);
    const vMajor = `${a0 + 1}.0.0`;
    const sNow = (await cfg('ontology/sofa/schema.yaml')).replace(/^version: .*$/m, `version: ${vMajor}`);
    const aNow = (await cfg('ontology/sofa/actions.yaml')).replace(`, ${PRE}]`, ']');
    void b0;
    const off = await api('POST', '/liquid/proposals', { title: 'Take the due-diligence rule off the release again (D3 re-run)', reason: 'The D3 scenario starts without the rule.', migrationNote: 'Only the precondition is removed; materials keep their risk class, statements stay.', changes: [{ path: 'ontology/sofa/schema.yaml', content: sNow }, { path: 'ontology/sofa/actions.yaml', content: aNow }] });
    if (!off.validation.ok) throw new Error(`could not take the rule off: ${JSON.stringify(off.validation.checks.filter((c) => !c.ok))}`);
    await gitHost().approveAndMerge(api, off.id, 'D3 re-run');
    live0 = await until('rule off', async () => {
      const o = await api('GET', '/liquid/ontology');
      return o.version === vMajor ? o : undefined;
    }, 120_000, 2000);
    await policyConverged(api);
    log(`the rule from an earlier run was taken off (ontology ${vMajor})`);
  }
  await api('POST', '/liquid/sim/reset');
  check('the running ontology does not know the rule yet', !live0.actions.find((a) => a.name === 'release_purchase_order')?.preconditions?.includes(PRE), `${live0.name}@${live0.version}`);
  const v1Po = JSON.parse(core('POST', '/actions/create_purchase_order', { supplierId: NEW_SUPPLIER, sku: SKU, quantity: 3000, _requestedBy: STEFAN.email }).body.result).id;
  await until(`${v1Po} released (v1)`, async () => (po(v1Po)?.released_at ? true : undefined), 90_000, 2000);
  check(`an order in flight before the change (${v1Po}, v1) is released as before`, !!po(v1Po)?.released_at, po(v1Po)?.released_at);

  // 1. the task for the modelling agent (scripted: the agent's tool calls)
  restoreTools = await grantTools(api, AGENT, ['config__read', 'config__validate', 'config__propose_change', 'config__get_proposal']);
  await until('gateway lists config tools for the agent', async () => (agentTool(AGENT, 'config__read', { path: 'OWNERS.yaml' }).isError ? undefined : true), 120_000, 5000);
  const schema0 = await file('ontology/sofa/schema.yaml');
  const actions0 = await file('ontology/sofa/actions.yaml');
  const roles0 = JSON.parse(await file('policies/liquid/roles/data.json'));
  const hasDds = /\n {2}DueDiligenceStatement:\n/.test(schema0);
  const v1 = bump(live0.version);

  // 2. the change: commodity risk of materials, the due-diligence statement (if not there yet), the rule on the release
  let schema = schema0.replace(/^version: .*$/m, `version: ${v1}`);
  // only what is missing (a re-run finds the attribute and the action from the first run)
  if (!/\n {6}commodity_risk:/.test(schema)) schema = schema.replace(/(\n {2}Material:\n(?:.*\n)*? {4}attributes:\n)/, `$1      commodity_risk: { range: CommodityRisk, description: Risk class of the commodity for supplier due diligence (D3) }${NL}`);
  if (!/\n {2}CommodityRisk:\n/.test(schema)) schema = schema.replace(/\nenums:\n/, `${NL}enums:${NL}  CommodityRisk:${NL}    description: Risk class of a commodity for supplier due diligence (deforestation, conflict minerals, forced labour)${NL}    permissible_values:${NL}      low: {}${NL}      high: {}${NL}`);
  if (!hasDds)
    schema = schema.replace(/\nclasses:\n/, [``, `classes:`, `  DueDiligenceStatement:`, `    description: A supplier's due-diligence statement (sanctions screening, conflict minerals, labour standards), recorded by a buyer.`, `    annotations: { criticality: business_critical, data_class: confidential, owner: head-of-logistics }`, `    attributes:`, `      id: { identifier: true, description: e.g. DDS-001 }`, `      supplier: { range: Supplier, required: true, description: The supplier the statement is about }`, `      statement: { required: true, description: What the supplier declares }`, `      sanctions_checked: { range: boolean, description: The supplier was screened against the sanctions lists }`, `      signed_by: { required: true, description: Name of the person who signs the statement }`, ``, ``].join(NL));
  // the check is declared once (a re-run finds it from the first run); the release names it
  // (before `events:` — new actions are appended at the end of the file, under `actions:`)
  let actions = actions0.includes(`  ${PRE}:`) ? actions0 : actions0.replace(/\nevents:\n/, `\n${CHECK_YAML}\nevents:\n`);
  actions = actions.replace(/(\n {2}- name: release_purchase_order\n(?:.*\n)*? {4}preconditions: \[)([^\]]*)\]/, (_m, a, list) => (list.includes(PRE) ? `${a}${list}]` : `${a}${list}, ${PRE}]`));
  if (!actions.includes('name: MaterialRiskClassified')) actions = actions.replace(/(\n {2}- \{ name: PurchaseOrderReleased[^\n]*\n)/, `$1  - { name: MaterialRiskClassified, object_type: Material, description: The commodity risk of a material was set }${NL}${hasDds ? '' : `  - { name: DueDiligenceStatementSubmitted, object_type: DueDiligenceStatement, description: A due-diligence statement of a supplier was recorded }${NL}`}`);
  if (!actions.includes('- name: set_commodity_risk')) actions += [
    `  - name: set_commodity_risk`,
    `    target: Material`,
    `    kind: update`,
    `    description: WRITE. Set the commodity risk class of a material (high-risk materials need a supplier due-diligence statement before release).`,
    `    input:`,
    `      sku: { range: Material, required: true, description: Material SKU }`,
    `      commodityRisk: { range: string, required: true, enum: [low, high], description: Risk class }`,
    `    emits: [MaterialRiskClassified]`,
    ...(hasDds
      ? []
      : [`  - name: submit_due_diligence_statement`, `    target: DueDiligenceStatement`, `    kind: create`, `    description: WRITE. Record a supplier's due-diligence statement.`, `    input:`, `      supplierId: { range: Supplier, required: true, description: Supplier id }`, `      statement: { range: string, required: true, description: What the supplier declares }`, `      sanctionsChecked: { range: boolean, description: Screened against the sanctions lists }`, `      signedBy: { range: string, required: true, description: Name of the person who signs }`, `    emits: [DueDiligenceStatementSubmitted]`]),
    ``,
  ].join(NL);
  roles0.roles.procurement.writes = [...new Set([...roles0.roles.procurement.writes, 'set_commodity_risk', 'submit_due_diligence_statement'])];
  const changes = [
    { path: 'ontology/sofa/schema.yaml', content: schema },
    { path: 'ontology/sofa/actions.yaml', content: actions },
    { path: 'policies/liquid/roles/data.json', content: JSON.stringify(roles0, null, 2) + NL },
  ];
  const v = JSON.parse(agentTool(AGENT, 'config__validate', { changes }).text);
  check('validation: compiles, additive (minor), existing data fits, policy tests pass', v.valid && v.compatibility?.level === 'minor', { checks: v.checks.map((c) => `${c.name}=${c.ok}`), diff: v.diff?.summary });

  // 3. evidence: shadow replay of the rule over the last week, timber classified high-risk
  const replay = await api('POST', '/liquid/shadow/precondition', { action: 'release_purchase_order', precondition: PRE, check: { name: PRE, ...CHECK }, windowMs: 7 * 86_400_000, assume: { Material: { [SKU]: { commodity_risk: 'high' } } } });
  check(`shadow replay: ${replay.blocked} of ${replay.total} releases of the last week (${replay.share} %) would have waited for a statement`, replay.total > 0, { examples: replay.examples.slice(0, 3).map((e) => e.poId) });
  metric('shadow_replay', { releases: replay.total, blocked: replay.blocked, sharePercent: replay.share });
  const prop = JSON.parse(agentTool(AGENT, 'config__propose_change', { title: 'Due diligence before releasing high-risk commodities (D3)', reason: 'Purchase orders for high-risk commodities need a valid supplier due-diligence statement before release.', evidence: JSON.stringify({ shadowReplay: replay, validation: v.diff?.summary }), changes }).text);
  check('the agent proposes it; the proposal is a pull request with the replay as evidence', prop.valid && prop.compatibility?.level === 'minor', { id: prop.id });

  // 4. the owner approves on the Git host → live in one reconcile
  const rev0 = (await api('GET', '/liquid/policy')).bundle?.revision;
  const tApprove = Date.now();
  await gitHost().approveAndMerge(api, prop.id, 'agreed with procurement (D3)');
  const live1 = await until('ontology live', async () => {
    const o = await api('GET', '/liquid/ontology');
    return o.version === v1 ? o : undefined;
  }, 120_000, 1000);
  metric('live_seconds_after_merge', Math.round((Date.now() - tApprove) / 1000));
  // the policy engines learn the new actions with the next package (fail closed until then: unknown actions are denied)
  await policyConverged(api, rev0);
  metric('policy_seconds_after_merge', Math.round((Date.now() - tApprove) / 1000));
  check('live: the rule is on the release action; Material.commodity_risk and the statement exist', live1.actions.find((a) => a.name === 'release_purchase_order')?.preconditions?.includes(PRE) && live1.classes.some((c) => c.name === 'DueDiligenceStatement') && live1.classes.find((c) => c.name === 'Material')?.attributes.some((a) => a.name === 'commodity_risk'), live1.version);

  // the app SDK changed: the sample app fails its re-check and is registered again with the new SDK
  const admin = new Session();
  await admin.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  const appSdk = await (await admin.raw(`${ADMIN}/api/liquid/ontology/sdk?kind=app`)).text();
  check('the app SDK is regenerated from the new ontology (setCommodityRisk, new version)', appSdk.includes('setCommodityRisk') && appSdk.includes(v1), appSdk.split(NL)[0]);
  if ((await api('GET', '/liquid/apps')).some((a) => a.id === APP_ID)) {
    const re = await api('POST', `/liquid/apps/${APP_ID}/recheck`);
    check('the registered app fails its re-check after the SDK changed (it loses sign-in until re-registered)', re.checks.some((c) => !c.ok && c.name === 'uses only the SDK'), re.status);
  }
  const app = await registerApp(admin, { dir: 'apps/liquid-app-due-diligence', id: APP_ID, name: 'Supplier due diligence', owner: STEFAN.email, description: 'Buyers record the due-diligence statements of suppliers.', actions: ['submit_due_diligence_statement'], reads: ['Supplier', 'DueDiligenceStatement'], activate: true });
  check('re-registered with the new SDK: checks pass, active', app.status === 'active' && app.checks.every((c) => c.ok), `version ${app.version}`);
  const access = await api('GET', `/liquid/apps/${APP_ID}/access`);
  const stefanUser = access.find((u) => u.email === STEFAN.email);
  if (!stefanUser.allowed) await api('PUT', `/liquid/apps/${APP_ID}/access/${stefanUser.id}`, { allowed: true });

  // 5. timber is classified high-risk (an action, an event)
  const cls = core('POST', '/actions/set_commodity_risk', { sku: SKU, commodityRisk: 'high', _requestedBy: STEFAN.email });
  check(`${SKU} classified high-risk through the new action (generic, from the IR)`, cls.status === 200, cls.body?.result?.slice(0, 80));
  const stmts0 = core('GET', '/objects/DueDiligenceStatement').body ?? [];
  check(`${NEW_SUPPLIER} has no valid statement yet`, !stmts0.some((x) => x.supplier === NEW_SUPPLIER && x.sanctions_checked === true), stmts0.length);

  // 6. a new order waits in v2; a direct release is refused by the rule; a reminder goes out
  const v2Po = JSON.parse(core('POST', '/actions/create_purchase_order', { supplierId: NEW_SUPPLIER, sku: SKU, quantity: 2500, _requestedBy: STEFAN.email }).body.result).id;
  const waitingAt = Date.now();
  const w = await until(`${v2Po} waits for the statement`, async () => {
    const r = await porState(v2Po);
    return r?.state === 'awaiting_due_diligence' ? r : undefined;
  }, 120_000, 2000);
  check(`the new order ${v2Po} runs PurchaseOrderRelease v2 and waits (awaiting_due_diligence) after its release window`, !!w && !po(v2Po)?.released_at, w?.workflowId);
  const direct = core('POST', '/actions/release_purchase_order', { poId: v2Po, _requestedBy: 'someone-in-a-hurry@sofaworks.example' });
  check('a direct release is refused by the rule (the ontology put it on the action)', direct.status === 422 && /due-diligence statement/.test(direct.body?.result ?? ''), direct.body?.result);
  const reminder = await until('reminder', async () => sql(`SELECT payload->>'subject' FROM events WHERE type = 'BusinessNotification' AND object_id = '${v2Po}' AND payload->>'kind' = 'due_diligence_missing' LIMIT 1`) || undefined, 90_000, 2000);
  check('a reminder goes out while it waits', !!reminder, reminder);

  // 7. the buyer submits the statement in the app → the order is released
  const st = new Session();
  await st.signIn(APP, STEFAN.email, PASSWORD);
  const sub = await st.raw(`${APP}/api/actions/submit_due_diligence_statement`, { method: 'POST', headers: { 'x-liquid-app': '1', referer: `${APP}/`, 'content-type': 'application/json' }, body: JSON.stringify({ supplierId: NEW_SUPPLIER, statement: 'FSC-certified pine; no conflict minerals; ILO core labour standards met; audit 2026 on file. (D3)', sanctionsChecked: true, signedBy: STEFAN.name }) });
  const subBody = await sub.json();
  check('the buyer submits the statement in the sample app', sub.status === 200 && subBody.ok, subBody.result?.slice(0, 80));
  const released = await until(`${v2Po} released`, async () => po(v2Po)?.released_at || undefined, 60_000, 2000);
  metric('waited_seconds_for_statement', Math.round((Date.now() - waitingAt) / 1000));
  check(`${v2Po} is released after the statement arrived`, !!released, released);
  const ev = sql(`SELECT actor_user || '|' || coalesce(payload->>'app','') FROM events WHERE seq = ${subBody.seq}`);
  check('the statement is an event of the buyer through the app', ev === `${STEFAN.email}|${APP_ID}`, ev);

  // 8. the v1 order finished (or finishes) on v1: no gate in its run
  const v1Run = await porState(v1Po);
  const v1Waited = sql(`SELECT count(*) FROM events WHERE type = 'BusinessNotification' AND object_id = '${v1Po}' AND payload->>'kind' = 'due_diligence_missing'`);
  check(`${v1Po} (started before the change) continues on v1: released before, never waited for a statement`, !!v1Run && v1Run.state !== 'awaiting_due_diligence' && v1Waited === '0' && !!po(v1Po)?.released_at, { state: v1Run?.state ?? v1Run?.status, workflow: v1Run?.workflowId });
  metric('evidence', { proposal: prop.id, ontology: v1, v1Order: v1Po, v2Order: v2Po, app: `${APP}/` });
  R.write(true);
} catch (err) {
  log(String(err));
  R.write(false, err);
  process.exitCode = 1;
} finally {
  await restoreTools?.().catch(() => undefined);
}
