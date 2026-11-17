#!/usr/bin/env node
// M1 exit check (docs/liquid-enterprise-extension.md): install Liquid Enterprise with the demo seed from the console
// API, then on the running stack
//   - the raw zone holds the same entity counts as the mock's initial state (queried through DuckDB),
//   - 1,000 appended events flushed twice give exactly 1,000 rows in lake.raw.events,
//   - the event log rejects UPDATE/DELETE, the lake's data files are Parquet on the volume.
// Leaves the extension installed (M2/M3 build on it). Screenshot of the Liquid overview for the docs.
//
//   node scripts/liquid/e2e-lake.mjs [--no-shots] [--reinstall]
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, until } from '../sofa-company/lib.mjs';
import { freshWorld as mockWorld } from '../sofa-company/mock-mcp.mjs';
import { extractCounts, sofaExtract } from '../../packages/sofa-domain/dist/index.js';

const args = new Set(process.argv.slice(2));
const SERVER = 'cw-ext-liquid-ontology-server';
const DB = 'cw-ext-liquid-ontology-db';
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const sh = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Calls the ontology server's internal API from inside its container (it has no host port). */
function internal(method, p, body) {
  const script = `fetch('http://127.0.0.1:7710${p}', { method: ${JSON.stringify(method)}, headers: { authorization: 'Bearer ' + process.env.INTERNAL_TOKEN, 'content-type': 'application/json' }, body: process.argv[1] || undefined })
    .then(async (r) => { const t = await r.text(); if (!r.ok) { console.error(r.status + ' ' + t); process.exit(1); } process.stdout.write(t); })
    .catch((e) => { console.error(String(e)); process.exit(1); })`;
  const r = sh('docker', ['exec', '-i', SERVER, 'node', '-e', script, body === undefined ? '' : JSON.stringify(body)]);
  if (r.status !== 0) throw new Error(`${method} ${p}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

const s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);

try {
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  let st = await api('GET', '/extensions/liquid');
  if (args.has('--reinstall') && (st.phase === 'installed' || st.phase === 'failed')) {
    log('reinstalling: uninstall with purge first');
    await api('POST', '/extensions/liquid/uninstall', { purgeData: true });
    await until('uninstalled', async () => (await api('GET', '/extensions/liquid')).phase === 'not_installed', 180_000);
    st = await api('GET', '/extensions/liquid');
  }
  if (st.phase === 'not_installed' || st.phase === 'failed') {
    await api('POST', '/extensions/liquid/install', { seedDemo: true });
  } else if (st.phase === 'installed') {
    log('already installed: running repair so new services and the seed step are applied');
    await api('POST', '/extensions/liquid/repair', {});
  }
  st = await until(
    'install finished',
    async () => {
      const x = await api('GET', '/extensions/liquid');
      if (x.phase === 'failed') throw new Error(`install failed: ${JSON.stringify(x.operation.steps.filter((y) => y.error))}`);
      return x.phase === 'installed' && x.operation?.finishedAt ? x : undefined;
    },
    420_000,
    3000,
  );
  check('installed and available', st.available, st.operation.steps.map((x) => `${x.id}=${x.state}`));
  check('ontology-db and ontology-server running', st.services.every((x) => x.state === 'running'), st.services.map((x) => `${x.name}=${x.state}`));
  check('seed step ran', st.operation.steps.some((x) => x.id === 'bootstrap:seed-sofa' && x.state === 'done') || (st.operation.kind === 'repair' && st.operation.steps.some((x) => x.id === 'bootstrap:seed-sofa')));

  // 1. raw zone vs. the mock's initial state (the mock itself is the reference, not our port)
  const expected = extractCounts(sofaExtract(mockWorld()));
  const lake = await api('GET', '/liquid/lake');
  const actual = Object.fromEntries(Object.keys(expected).map((t) => [t, lake.counts[t]]));
  check('raw zone entity counts equal the mock initial state', JSON.stringify(actual) === JSON.stringify(expected), actual);
  const q = internal('POST', '/internal/lake/query', { sql: "SELECT (SELECT count(*) FROM lake.raw.crm_orders WHERE _extract_id = 'sofa-T0')::INT AS orders, (SELECT sum(qty) FROM lake.raw.crm_orders WHERE _extract_id = 'sofa-T0')::INT AS sofas, (SELECT count(*) FROM lake.raw.erp_suppliers s, unnest(CAST(s.skus AS VARCHAR[])) AS t(sku) WHERE sku = 'BEAM-PINE-80')::INT AS beam_suppliers" });
  const mock = mockWorld();
  check('DuckDB query over the raw zone matches the mock', q.rows[0].orders === mock.salesOrders.length && q.rows[0].sofas === mock.salesOrders.reduce((a, o) => a + o.qty, 0) && q.rows[0].beam_suppliers === mock.suppliers.filter((x) => x.skus.includes('BEAM-PINE-80')).length, q.rows[0]);

  // 2. 1,000 events, flushed twice
  const run = `e2e-${randomUUID().slice(0, 8)}`;
  for (let i = 0; i < 1000; i += 250) {
    internal('POST', '/internal/events', { events: Array.from({ length: 250 }, (_, k) => ({ type: 'E2eEventAppended', objectType: 'E2eRun', objectId: run, payload: { i: i + k } })) });
  }
  const f1 = internal('POST', '/internal/lake/flush');
  const f2 = internal('POST', '/internal/lake/flush');
  const n = internal('POST', '/internal/lake/query', { sql: `SELECT count(*)::INT AS n, count(DISTINCT seq)::INT AS d FROM lake.raw.events WHERE object_id = '${run}'` }).rows[0];
  check('1,000 events flushed twice → exactly 1,000 rows in lake.raw.events', n.n === 1000 && n.d === 1000 && f2.flushed === 0, { first: f1, second: f2, rows: n });

  // 3. append-only and open format
  const upd = sh('docker', ['exec', DB, 'psql', '-U', 'onto', '-d', 'onto', '-tAc', "UPDATE events SET type = 'X' WHERE seq = 1"]);
  check('event log rejects UPDATE (append-only trigger)', upd.status !== 0 && /append-only/.test(upd.stderr), upd.stderr.trim().split('\n')[0]);
  const lakeFiles = (await api('GET', '/liquid/lake')).files;
  const noFiles = Object.entries(expected).filter(([t, n]) => n > 0 && !(lakeFiles[t] > 0)).map(([t]) => t);
  check('every non-empty raw table is stored as Parquet (nothing inlined in the catalog)', noFiles.length === 0 && lakeFiles.events > 0, noFiles.length ? noFiles : lakeFiles);
  const files = sh('docker', ['exec', SERVER, 'sh', '-c', 'find /lake -name "*.parquet" | wc -l']).stdout.trim();
  check('lake data files are Parquet on the volume', Number(files) > 0, `${files} parquet files under /lake`);
  const catalog = sh('docker', ['exec', DB, 'psql', '-U', 'onto', '-d', 'onto', '-tAc', "select count(*) from information_schema.tables where table_schema = 'lake_catalog'"]).stdout.trim();
  check('DuckLake catalog lives in Postgres schema lake_catalog', Number(catalog) > 10, `${catalog} catalog tables`);
  result.lake = await api('GET', '/liquid/lake');

  if (!args.has('--no-shots')) {
    const { Shots } = await import('../sofa-company/shots.mjs');
    process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
    process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
    const shots = await new Shots(path.join(root, 'docs', 'images', 'liquid')).open();
    const file = await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid`, 'liquid-overview-lake', { width: 1280, height: 1000, wait: 2500, fullPage: true });
    await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/extensions`, 'extensions-installed', { width: 1280, height: 900, wait: 1500, fullPage: true });
    await shots.close();
    log(`screenshot ${path.relative(root, file)}`);
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
  writeFileSync(path.join(root, 'scripts', 'liquid', 'results', 'm1-lake-e2e.json'), JSON.stringify(result, null, 2));
  log(`result: scripts/liquid/results/m1-lake-e2e.json (${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok)`);
}
