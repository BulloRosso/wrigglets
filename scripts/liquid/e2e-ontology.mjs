#!/usr/bin/env node
// M2 / E1 check on the running stack: the ontology server serves the compiled IR (same hash as the committed
// packages/ontology-sofa/ir/ontology.ir.json), the console offers the Ontology page, and the React Flow graph renders
// every class. Screenshots for docs/liquid-enterprise.md.
//
//   node scripts/liquid/e2e-ontology.mjs [--no-shots]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';

const args = new Set(process.argv.slice(2));
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const committed = JSON.parse(readFileSync(path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json'), 'utf8'));
const s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);

try {
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  let st = await api('GET', '/extensions/liquid');
  if (st.phase !== 'installed') throw new Error(`liquid is ${st.phase}; install it first (node scripts/liquid/e2e-lake.mjs)`);
  await api('POST', '/extensions/liquid/repair', {});
  st = await until('repair finished', async () => {
    const x = await api('GET', '/extensions/liquid');
    if (x.phase === 'failed') throw new Error(JSON.stringify(x.operation.steps.filter((y) => y.error)));
    return x.phase === 'installed' && x.operation?.finishedAt && x.available ? x : undefined;
  }, 300_000, 3000);
  check('repair picked up the new images and is available', st.available, st.operation.steps.map((x) => `${x.id}=${x.state}`));
  check('the Ontology page is offered to the nav', st.uiRoutes.some((r) => r.path === '/liquid/ontology'), st.uiRoutes);

  let ir = await until('ontology served', () => api('GET', '/liquid/ontology'), 60_000);
  // since ADR-0049 the ontology in force is the one of the config repository's main (applied by the reconciler); after
  // test runs its version may be higher than the built-in one, with the same structure
  const main = Object.fromEntries(await Promise.all(['schema.yaml', 'actions.yaml', 'bindings.yaml'].map(async (f) => [f, (await api('GET', `/liquid/config/file?path=ontology/sofa/${f}`)).content])));
  const sha = (t) => createHash('sha256').update(t.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  ir = await until('the core runs main\'s ontology', async () => {
    const x = await api('GET', '/liquid/ontology');
    return Object.entries(main).every(([f, t]) => x.source.files[f] === sha(t)) ? x : undefined;
  }, 90_000, 3000).catch(() => ir);
  check('the enterprise core runs the ontology of the config repository (source hashes of main)', Object.entries(main).every(([f, t]) => ir.source.files[f] === sha(t)), `${ir.name}@${ir.version} ${ir.hash.slice(0, 12)}`);
  // every built-in class and action is served; additions came through reviewed changes (e.g. M9's DueDiligenceStatement)
  const missing = [...committed.classes.filter((c) => !ir.classes.some((x) => x.name === c.name)).map((c) => c.name), ...committed.actions.filter((a) => !ir.actions.some((x) => x.name === a.name)).map((a) => a.name)];
  const added = [...ir.classes.filter((c) => !committed.classes.some((x) => x.name === c.name)).map((c) => c.name), ...ir.actions.filter((a) => !committed.actions.some((x) => x.name === a.name)).map((a) => a.name)];
  check('every class and action of the built-in sofa ontology is served (additions only through reviewed changes)', missing.length === 0, { classes: ir.classes.length, actions: ir.actions.length, links: ir.links.length, builtIn: committed.version, added });

  if (!args.has('--no-shots')) {
    const { Shots } = await import('../sofa-company/shots.mjs');
    process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
    process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
    const shots = await new Shots(path.join(root, 'docs', 'images', 'liquid')).open();
    const page = await shots.page(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid/ontology`, { width: 1600, height: 1000 });
    await page.waitForSelector('.react-flow__node', { timeout: 30_000 });
    await sleep(1500);
    const rendered = await page.locator('.react-flow__node').count();
    check('React Flow renders one node per class', rendered === ir.classes.length, `${rendered} nodes`);
    const edges = await page.locator('.react-flow__edge').count();
    check('React Flow renders one edge per link', edges === ir.links.length, `${edges} edges`);
    await page.screenshot({ path: path.join(root, 'docs/images/liquid/ontology-graph.png') });
    await page.locator('.react-flow__node[data-id="PurchaseOrder"]').click();
    await sleep(1200);
    const panel = await page.getByText('lake.raw.erp_purchase_orders').count();
    check('selecting a class shows its details and source table', panel > 0);
    await page.screenshot({ path: path.join(root, 'docs/images/liquid/ontology-selected.png') });
    await page.getByLabel('Criticality').click();
    await page.getByRole('option', { name: 'payment critical' }).click();
    await sleep(600);
    await page.screenshot({ path: path.join(root, 'docs/images/liquid/ontology-filter.png') });
    await page.close();
    await shots.close();
    log('screenshots: docs/images/liquid/ontology-{graph,selected,filter}.png');
  }
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err?.message ?? err);
  log(`ERROR ${result.error}`);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  mkdirSync(path.join(root, 'scripts', 'liquid', 'results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'liquid', 'results', 'm2-ontology-e2e.json'), JSON.stringify(result, null, 2));
  log(`result: scripts/liquid/results/m2-ontology-e2e.json (${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok)`);
}
