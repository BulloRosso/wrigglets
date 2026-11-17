#!/usr/bin/env node
// The guided tutorial (ADR-0054) on the running stack: every chapter, with the same API calls the evaluator's clicks
// make (console pages, Forgejo as reviewer, the sample app as the buyer), and after each chapter the tutorial page as
// the evaluator sees it. Every step's check on the page must tick: the script reads the page and counts the ticks.
//
//   node scripts/liquid/e2e-tutorial.mjs [--shots]      --shots writes docs/images/liquid/tutorial/*.png
//
// Before the run, a due-diligence rule left live by D3 is taken off (a reviewed change), so chapter 7 starts as on a
// fresh install. Chapter 5 leaves a new class in the ontology; the next e2e-ontology-evolution run takes Carrier off.
import { HUMANS, PASSWORD, Session } from '../sofa-company/lib.mjs';
import { Shots } from '../sofa-company/shots.mjs';
import { registerApp } from './app-register.mjs';
import { ADMIN, adminSession, env, gitHost, log, policyConverged, results, root, sleep, until } from './lib.mjs';
import path from 'node:path';

const R = results('tutorial');
const { check, metric } = R;
const SHOTS = process.argv.includes('--shots');
const PRE = 'due_diligence_for_high_risk_material';
const APP_ID = 'supplier-due-diligence';
const APP = `http://${env.PUBLIC_HOST || 'localhost'}:8090/apps/${APP_ID}`;
const STEFAN = HUMANS.stefan;
const SUGGEST = ['Carrier', 'Warehouse', 'Shipment', 'Inspection', 'Forwarder', 'Dock'];

let shots;
let page; // the tutorial page in a browser, signed in as the admin
async function tutorialPage() {
  if (!shots) {
    process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
    process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
    shots = new Shots(path.join(root, 'docs/images/liquid/tutorial'));
    await shots.open();
  }
  page = page ?? (await shots.page(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid/tutorial`, { width: 1440, height: 1000, wait: 4000 }));
  return page;
}
/** Ticks on the page: the chapter chips "n/m" (the page computes them from the live platform, like for a person). */
async function ticks(chapterTitle, want, timeoutMs = 30_000) {
  const p = await tutorialPage();
  return until(`tutorial page: ${chapterTitle} ${want}`, async () => {
    await p.goto(`${ADMIN}/liquid/tutorial`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(3500);
    const chip = await p.locator('.MuiAccordionSummary-root', { hasText: chapterTitle }).locator('.MuiChip-label').first().textContent().catch(() => null);
    return chip === want ? chip : undefined;
  }, timeoutMs, 1000);
}
async function shot(name, chapterTitle) {
  if (!SHOTS) return;
  const p = await tutorialPage();
  await p.goto(`${ADMIN}/liquid/tutorial`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(3500);
  const file = path.join(root, 'docs/images/liquid/tutorial', `${name}.png`);
  if (chapterTitle) {
    // the whole chapter, opened: its steps, their ticks and "What just happened"
    const acc = p.locator('.MuiAccordion-root', { has: p.locator('.MuiAccordionSummary-root', { hasText: chapterTitle }) }).first();
    const s = acc.locator('.MuiAccordionSummary-root').first();
    if ((await s.getAttribute('aria-expanded')) !== 'true') await s.click();
    await p.waitForTimeout(800);
    // the console's fixed header would cover the top of a tall element screenshot
    const style = await p.addStyleTag({ content: 'header.MuiAppBar-root { visibility: hidden !important; }' });
    await acc.screenshot({ path: file });
    await style.evaluate((n) => n.remove());
  } else await p.screenshot({ path: file });
  log(`shot ${name}`);
}

try {
  const { api } = await adminSession();
  const ME = env.BOOTSTRAP_ADMIN_EMAIL;
  const forge = gitHost();
  const ontology = () => api('GET', '/liquid/ontology');
  const ddLive = (o) => o.actions.find((a) => a.name === 'release_purchase_order')?.preconditions?.includes(PRE);

  // pre: chapter 7 starts without the rule (as on a fresh install)
  let o0 = await ontology();
  if (ddLive(o0)) {
    const cfg = async (p) => (await api('GET', `/liquid/config/file?path=${p}`)).content;
    const vMajor = `${Number(o0.version.split('.')[0]) + 1}.0.0`;
    const off = await api('POST', '/liquid/proposals', {
      title: 'Take the due-diligence rule off the release (tutorial pre-run)',
      reason: 'The tutorial starts without the rule.',
      migrationNote: 'Only the precondition is removed; materials keep their risk class, statements stay.',
      changes: [
        { path: 'ontology/sofa/schema.yaml', content: (await cfg('ontology/sofa/schema.yaml')).replace(/^version: .*$/m, `version: ${vMajor}`) },
        { path: 'ontology/sofa/actions.yaml', content: (await cfg('ontology/sofa/actions.yaml')).replace(`, ${PRE}]`, ']') },
      ],
    });
    if (!off.validation.ok) throw new Error(`could not take the rule off: ${JSON.stringify(off.validation.checks.filter((c) => !c.ok))}`);
    await forge.approveAndMerge(api, off.id, 'tutorial pre-run');
    o0 = await until('rule off', async () => {
      const o = await ontology();
      return o.version === vMajor ? o : undefined;
    }, 120_000, 2000);
    await policyConverged(api);
    log(`pre-run: the rule was taken off (ontology ${vMajor})`);
  }

  /* ---------------------------------------------------------------------------------------- 0. prepare */
  // the page's suggestion (apps/admin-web/src/tutorial/steps.ts freeClassName)
  const taken = o0.classes.map((c) => c.name);
  let name = SUGGEST.find((n) => !taken.includes(n));
  for (let i = 2; !name; i++) if (!taken.includes(`Carrier${i}`)) name = `Carrier${i}`;
  const prep = await api('POST', '/liquid/tutorial/prepare');
  check('prepare: the demo world has three open orders', prep.purchaseOrders.length === 3, prep);
  // the page's state, as the page itself stores it after "Prepare"
  const run = { startedAt: prep.startedAt, startSeq: prep.startSeq, startVersion: o0.version, suggestedClass: name, purchaseOrders: prep.purchaseOrders, manual: { events: true, explore: true } };
  const p = await tutorialPage();
  await p.evaluate((r) => localStorage.setItem('cw.liquid.tutorial', JSON.stringify(r)), run);
  await ticks('Prepare the demo world', '1/1');
  await shot('t00-start');

  /* ---------------------------------------------------------------------------------------- 1. data */
  await until('flush has the orders', async () => ((await api('GET', '/liquid/lake')).hwm >= prep.startSeq ? true : undefined), 90_000, 2000);
  const created = await api('GET', `/liquid/events?types=PurchaseOrderCreated&actor=${encodeURIComponent(ME)}&since=${encodeURIComponent(prep.startedAt)}`);
  check('1 · the orders are events by the evaluator, and in the lake', created.events.length >= 3, created.events.map((e) => e.object_id));
  await ticks('1 · Your data', '2/2');
  await shot('t01-data', '1 · Your data');

  /* ---------------------------------------------------------------------------------------- 3. policy (2 is looking only) */
  const cancel = await api('POST', '/liquid/tutorial/action', { action: 'cancel_purchase_order', args: { poId: prep.purchaseOrders[0], reason: 'Tutorial: the supplier cannot deliver in time' } });
  check('3 · Lara’s cancel is not run: four eyes for a payment-critical order', !cancel.ok, cancel.result);
  const req = await until('approval request in the inbox', async () => (await api('GET', '/liquid/inbox')).find((i) => i.kind === 'action' && i.detail?.action === 'cancel_purchase_order' && i.detail?.args?.poId === prep.purchaseOrders[0]), 30_000, 1000);
  await api('POST', `/liquid/approvals/${encodeURIComponent(req.id)}/decide`, { decision: 'approve', comment: 'tutorial: agreed' });
  const cancelled = await until('cancelled with approvedBy', async () => (await api('GET', `/liquid/events?types=PurchaseOrderCancelled&since=${encodeURIComponent(prep.startedAt)}`)).events.find((e) => e.payload.approvedBy), 60_000, 1000);
  check('3 · approved by the evaluator: cancelled, the event records approvedBy', cancelled.payload.approvedBy === ME, cancelled.payload.approvedBy);
  const rev0 = (await api('GET', '/liquid/policy')).bundle?.revision;
  const ov = await api('POST', '/liquid/policy/overlays', { effect: 'deny', reason: 'Tutorial: purchasing frozen', match: { actions: ['create_purchase_order'] } });
  const rev1 = await policyConverged(api, rev0);
  const denied = await api('POST', '/liquid/tutorial/action', { action: 'create_purchase_order', args: { supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', quantity: 2000 } });
  check('3 · the overlay denies a person’s order within one policy poll', denied.status === 403, denied.result);
  await api('DELETE', `/liquid/policy/overlays/${ov.id}`);
  await policyConverged(api, rev1);
  const again = await api('POST', '/liquid/tutorial/action', { action: 'create_purchase_order', args: { supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', quantity: 2000 } });
  check('3 · freeze lifted (audited): the order goes through', again.ok, again.result?.slice(0, 80));
  await ticks('3 · Rules as code', '5/5', 60_000);
  await shot('t03-policy', '3 · Rules as code');

  /* ---------------------------------------------------------------------------------------- 4. hold */
  const hold = await api('POST', '/liquid/processes/hold', { objects: ['Supplier:S-NORDHOLZ'], reason: 'tutorial: supplier under review' });
  check('4 · hold by object reaches the release workflows of the orders', hold.workflows.length >= 2, hold.workflows.length);
  await until('held', async () => ((await api('GET', '/liquid/processes')).running.filter((r) => r.hold?.held).length >= 2 ? true : undefined), 30_000, 1000);
  if (SHOTS) await shots.snap(ME, `${ADMIN}/liquid/processes?tab=running`, 't04-held', { width: 1440, height: 900, wait: 4000 });
  await api('POST', '/liquid/processes/release', { ref: hold.ref });
  await ticks('4 · Processes', '2/2', 60_000);

  /* ---------------------------------------------------------------------------------------- 5. change */
  const dr = await api('POST', '/liquid/ontology/drafts', { domain: 'sofa' });
  await api('POST', `/liquid/ontology/drafts/${dr.id}/ops`, {
    ops: [
      { op: 'add_class', name, description: `A ${name.toLowerCase()} of the sofa company (tutorial).`, identifier: 'id', annotations: { criticality: 'normal', data_class: 'internal', owner: 'head-of-logistics' } },
      { op: 'add_attribute', class: name, name: 'name', required: true },
      { op: 'add_link', from: 'PurchaseOrder', attribute: name.toLowerCase(), to: name },
    ],
  });
  const v = await api('POST', `/liquid/ontology/drafts/${dr.id}/validate`);
  await api('POST', `/liquid/ontology/drafts/${dr.id}/ops`, { ops: [{ op: 'set_version', version: v.compat.suggestedVersion }] });
  if (SHOTS) await shots.snap(ME, `${ADMIN}/liquid/ontology?draft=${dr.id}`, 't05-draft', { width: 1440, height: 900, wait: 4000 });
  const prop = await api('POST', `/liquid/ontology/drafts/${dr.id}/submit`, { title: `${name} for purchase orders`, reason: 'Tutorial: we need to see who delivers an order.' });
  check(`5 · the draft (${name}) is a valid, minor proposal`, prop.validation.ok && prop.compat?.level === 'minor', prop.compat);
  const withPr = await until('pull request', async () => {
    const x = await api('GET', `/liquid/proposals/${prop.id}`);
    return x.pr ? x : undefined;
  }, 90_000, 2000);
  if (SHOTS) await shots.snap(ME, `${ADMIN}/liquid/proposals/${prop.id}?view=ontology`, 't05-proposal', { width: 1440, height: 1100, wait: 4000 });
  const tMerge = Date.now();
  await forge.approveAndMerge(api, prop.id, 'tutorial');
  const o5 = await until('live', async () => {
    const o = await ontology();
    return o.version === v.compat.suggestedVersion ? o : undefined;
  }, 120_000, 1000);
  metric('chapter5_live_seconds_after_merge', Math.round((Date.now() - tMerge) / 1000));
  check(`5 · merged on the Git host (PR #${withPr.pr.number}); ${name} live in ${o5.version}`, o5.classes.some((c) => c.name === name));
  await ticks('5 · Change through review', '4/4', 60_000);
  await shot('t05-change', '5 · Change through review');

  /* ---------------------------------------------------------------------------------------- 6. contain */
  const alert = await api('POST', '/liquid/playbooks/alerts', { source: 'vuln-feed', severity: 'critical', upstream: 'erp', summary: 'CVE-2026-0001 in the ERP connector' });
  const runId = alert.runs[0].runId;
  const r6 = await until('contained', async () => (await api('GET', '/liquid/playbooks/runs')).find((r) => r.runId === runId && r.state === 'awaiting_approval'), 60_000, 1000);
  const erpOff = (await api('GET', '/gateway')).upstreams.find((u) => u.name === 'erp')?.enabled === false;
  check('6 · contained automatically: erp disabled, overlay, workflows held, owner mailed', erpOff && r6.steps.filter((s) => s.autonomy === 'auto').every((s) => s.state === 'done'), r6.steps.map((s) => `${s.id}=${s.state}`));
  if (SHOTS) await shots.snap(ME, `${ADMIN}/liquid/playbooks?tab=active`, 't06-contained', { width: 1440, height: 1000, wait: 4000 });
  if (SHOTS) await shots.snap(ME, `${ADMIN}/liquid/approvals`, 't06-approvals', { width: 1440, height: 800, wait: 4000 });
  await api('POST', `/liquid/playbooks/runs/${runId}/steps/restore/decide`, { decision: 'approve', comment: 'tutorial: fix verified' });
  await until('restored', async () => ((await api('GET', '/liquid/playbooks/runs')).find((r) => r.runId === runId)?.state === 'completed' && (await api('GET', '/gateway')).upstreams.find((u) => u.name === 'erp')?.enabled !== false ? true : undefined), 60_000, 1000);
  check('6 · restored after the person’s approval', true);
  await ticks('6 · Contain automatically', '3/3', 60_000);
  await shot('t06-contain', '6 · Contain automatically');

  /* ---------------------------------------------------------------------------------------- 7. requirement */
  const dd = await api('POST', '/liquid/tutorial/propose/due-diligence');
  check('7 · the prepared rule is a valid, minor proposal with the shadow replay as evidence', dd.validation.ok && dd.compat?.level === 'minor' && dd.shadowReplay?.total >= 0, { compat: dd.compat?.level, replay: dd.shadowReplay && { total: dd.shadowReplay.total, blocked: dd.shadowReplay.blocked } });
  if (SHOTS) await shots.snap(ME, `${ADMIN}/liquid/proposals/${dd.id}?view=summary`, 't07-proposal', { width: 1440, height: 1100, wait: 4000 });
  const revD = (await api('GET', '/liquid/policy')).bundle?.revision;
  await forge.approveAndMerge(api, dd.id, 'tutorial: agreed with procurement');
  const o7 = await until('rule live', async () => {
    const o = await ontology();
    return ddLive(o) ? o : undefined;
  }, 120_000, 1000);
  await policyConverged(api, revD);
  check('7 · the rule is live on the release action', ddLive(o7), o7.version);
  const recheck = await api('POST', `/liquid/apps/${APP_ID}/recheck`);
  check('7 · the sample app’s SDK is stale: its check fails', recheck.checks.some((c) => !c.ok), recheck.status);
  const admin = new Session();
  await admin.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  const app = await registerApp(admin, { dir: 'apps/liquid-app-due-diligence', id: APP_ID, name: 'Supplier due diligence', owner: STEFAN.email, description: 'Buyers record the due-diligence statements of suppliers.', actions: ['submit_due_diligence_statement'], reads: ['Supplier', 'DueDiligenceStatement'], activate: true });
  check('7 · the owner re-registered the app on the new SDK', app.status === 'active', app.version);
  const { candidate, covered } = await api('GET', '/liquid/tutorial/due-diligence');
  check('7 · a material and supplier without a statement are left (timber from Nordholz on a fresh install)', !!candidate, { candidate, covered });
  const { sku, supplier, quantity } = candidate;
  const cls = await api('POST', '/liquid/tutorial/action', { action: 'set_commodity_risk', args: { sku, commodityRisk: 'high' } });
  check(`7 · ${sku} classified high-risk (a generic action from the IR)`, cls.ok, cls.result?.slice(0, 80));
  const order = await api('POST', '/liquid/tutorial/action', { action: 'create_purchase_order', args: { supplierId: supplier, sku, quantity } });
  const ddOrder = JSON.parse(order.result).id;
  await p.evaluate(([o, sup]) => {
    const r = JSON.parse(localStorage.getItem('cw.liquid.tutorial'));
    localStorage.setItem('cw.liquid.tutorial', JSON.stringify({ ...r, ddOrder: o, ddSupplier: sup[0], ddSku: sup[1] }));
  }, [ddOrder, [supplier, sku]]);
  const waiting = await until(`${ddOrder} waits`, async () => {
    const pr = await api('GET', '/liquid/processes');
    return pr.running.find((r) => r.type === 'PurchaseOrderRelease' && r.objects.includes(`PurchaseOrder:${ddOrder}`) && r.state === 'awaiting_due_diligence');
  }, 120_000, 2000);
  check(`7 · the new order ${ddOrder} waits for a statement`, !!waiting, waiting.workflowId);
  if (SHOTS) await shots.snap(ME, `${ADMIN}/liquid/processes?tab=running`, 't07-waiting', { width: 1440, height: 900, wait: 4000 });
  // the buyer in the app (the admin may use it too; the buyer is the realistic actor)
  const access = await api('GET', `/liquid/apps/${APP_ID}/access`);
  const su = access.find((u) => u.email === STEFAN.email);
  if (su && !su.allowed) await api('PUT', `/liquid/apps/${APP_ID}/access/${su.id}`, { allowed: true });
  const st = new Session();
  await st.signIn(APP, STEFAN.email, PASSWORD);
  if (SHOTS) {
    const ap = await shots.page(STEFAN.email, `${APP}/`, { width: 1280, height: 900 });
    await ap.waitForTimeout(2500);
    // the form as the buyer fills it (the submit below is the app's own API call with the buyer's session)
    await ap.locator('select').first().selectOption(supplier).catch(() => undefined);
    await ap.locator('textarea').first().fill('Certified sourcing; no conflict minerals; ILO core labour standards met.').catch(() => undefined);
    await ap.getByLabel(/sanctions/i).check().catch(() => undefined);
    await ap.screenshot({ path: path.join(root, 'docs/images/liquid/tutorial', 't07-app.png') });
  }
  const sub = await st.raw(`${APP}/api/actions/submit_due_diligence_statement`, { method: 'POST', headers: { 'x-liquid-app': '1', referer: `${APP}/`, 'content-type': 'application/json' }, body: JSON.stringify({ supplierId: supplier, statement: 'Certified sourcing; no conflict minerals; ILO core labour standards met. (tutorial)', sanctionsChecked: true, signedBy: STEFAN.name }) });
  check('7 · the buyer submits the statement in the app', sub.status === 200, sub.status);
  await until(`${ddOrder} released`, async () => ((await api('GET', `/liquid/events?types=PurchaseOrderReleased&object=${ddOrder}`)).events.length ? true : undefined), 90_000, 2000);
  check(`7 · ${ddOrder} is released after the statement arrived`, true);
  await ticks('7 · A new business requirement', '6/6', 60_000);
  await shot('t07-requirement', '7 · A new business requirement');

  // the whole page, everything ticked
  const all = await (await tutorialPage()).locator('text=/\\d+ of \\d+ steps done/').first().textContent();
  check('the tutorial page shows every step done', /^(\d+) of \1 steps done$/.test(all ?? ''), all);
  if (SHOTS) {
    const tp = await tutorialPage();
    await tp.goto(`${ADMIN}/liquid/tutorial`, { waitUntil: 'networkidle' });
    await tp.waitForTimeout(3500);
    await tp.screenshot({ path: path.join(root, 'docs/images/liquid/tutorial', 't99-done.png') });
    await shots.snap(ME, `${ADMIN}/liquid/events?since=${encodeURIComponent(prep.startedAt)}`, 't99-events', { width: 1440, height: 1000, wait: 4000 });
  }
  R.write(true);
} catch (err) {
  log(String(err?.stack ?? err));
  R.write(false, err);
  process.exitCode = 1;
} finally {
  await shots?.close().catch(() => undefined);
  void sleep;
}
