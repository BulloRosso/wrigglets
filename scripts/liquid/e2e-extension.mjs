#!/usr/bin/env node
// M0b exit check (docs/liquid-enterprise-extension.md): install Liquid Enterprise from the admin console API, restart
// the control plane in the middle of the install (it must resume), check containers and availability, uninstall, check
// that nothing is left. Takes the screenshots for docs/liquid-enterprise.md on the way.
//
//   node scripts/liquid/e2e-extension.mjs [--no-shots] [--keep]      (--keep: leave it installed at the end)
// Prerequisites: running stack with the current control-plane image; scripts/sofa-company `npm install` for screenshots.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';

const args = new Set(process.argv.slice(2));
const SHOTS = !args.has('--no-shots');
const shotsDir = path.join(root, 'docs', 'images', 'liquid');
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' }).stdout.trim();
const extContainers = () => docker('ps', '-a', '--filter', 'label=cw.extension=liquid', '--format', '{{.Names}} {{.Status}}').split('\n').filter(Boolean);

const s = new Session();
const signIn = () => s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
const status = () => api('GET', '/extensions/liquid');

let shots;
async function snap(name, url, opts = {}) {
  if (!SHOTS) return;
  if (!shots) {
    const { Shots } = await import('../sofa-company/shots.mjs');
    process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
    process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
    shots = await new Shots(shotsDir).open();
  }
  const file = await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, url, name, { width: 1280, height: 900, wait: 1500, ...opts });
  log(`screenshot ${path.relative(root, file)}`);
}

try {
  await signIn();
  let st = await status();
  if (st.mode !== 'console') throw new Error(`liquid runs in ${st.mode} mode; stop the overlay first`);
  if (st.phase === 'installed' || st.phase === 'failed') {
    log('liquid is installed from an earlier run: uninstalling first');
    await api('POST', '/extensions/liquid/uninstall', { purgeData: true });
    await until('uninstalled', async () => (await status()).phase === 'not_installed', 120_000);
  }
  check('starts not installed and not available', (st = await status()) && st.phase === 'not_installed' && !st.available);
  check('no liquid containers before install', extContainers().length === 0, extContainers());
  await snap('extensions-not-installed', `${ADMIN}/extensions`);

  // install; restart the control plane while it runs
  await api('POST', '/extensions/liquid/install', { seedDemo: true });
  await sleep(600);
  await snap('extensions-installing', `${ADMIN}/extensions`, { wait: 300 });
  const mid = await status();
  log(`phase before restart: ${mid.phase}; steps: ${mid.operation.steps.map((x) => `${x.id}=${x.state}`).join(', ')}`);
  const interrupted = mid.phase === 'installing';
  docker('restart', 'cw-temporal');
  await until('control plane healthy after restart', async () => (await fetch(`${ADMIN}/health`)).ok, 180_000);
  await signIn().catch(() => undefined);
  st = await until(
    'install finished',
    async () => {
      const x = await status();
      if (x.phase === 'failed') throw Object.assign(new Error('failed'), { st: x });
      return x.phase === 'installed' ? x : undefined;
    },
    240_000,
  ).catch(async (err) => {
    const x = await status();
    throw new Error(`install did not finish: ${x.phase} ${JSON.stringify(x.operation?.steps.filter((y) => y.error))} (${err.message})`);
  });
  check(interrupted ? 'install interrupted by a restart resumed and finished' : 'install finished (finished before the restart could interrupt it)', st.phase === 'installed', { interrupted });
  check('every step done', st.operation.steps.every((x) => x.state === 'done'), st.operation.steps.map((x) => x.id));
  check('available after install', st.available === true);
  check('ontology-db container is labelled and healthy', extContainers().some((c) => c.startsWith('cw-ext-liquid-ontology-db') && /healthy/.test(c)), extContainers());
  const volumes = docker('volume', 'ls', '--filter', 'label=cw.role=extension-data', '--format', '{{.Name}}');
  check('data volume created', /cw-ext-liquid-ontology-db-data/.test(volumes), volumes);
  const pg = spawnSync('docker', ['exec', 'cw-ext-liquid-ontology-db', 'psql', '-U', 'onto', '-d', 'onto', '-tAc', 'select 1'], { encoding: 'utf8' });
  check('ontology-db answers queries', pg.stdout.trim() === '1', pg.stderr.trim() || undefined);
  const audit = await api('GET', '/audit?target=liquid');
  check('install audited', audit.some((e) => e.action === 'extension.install') && audit.some((e) => e.action === 'extension.install.done'), audit.slice(0, 4).map((e) => e.action));
  const nav = (await api('GET', '/extensions')).find((e) => e.id === 'liquid').uiRoutes;
  check('Liquid pages offered to the nav', nav.some((r) => r.path === '/liquid'), nav);

  await snap('extensions-installed', `${ADMIN}/extensions`, { fullPage: true });
  await snap('liquid-overview', `${ADMIN}/liquid`);

  // repair is idempotent: keeps the healthy container
  const before = docker('inspect', '-f', '{{.Id}}', 'cw-ext-liquid-ontology-db');
  await api('POST', '/extensions/liquid/repair', {});
  await until('repair finished', async () => (await status()).phase === 'installed' && !!(await status()).operation.finishedAt, 120_000);
  check('repair keeps an unchanged, healthy container', docker('inspect', '-f', '{{.Id}}', 'cw-ext-liquid-ontology-db') === before);

  if (!args.has('--keep')) {
    await api('POST', '/extensions/liquid/uninstall', { purgeData: true });
    st = await until('uninstalled', async () => {
      const x = await status();
      return x.phase === 'not_installed' ? x : undefined;
    }, 120_000);
    check('uninstalled and not available', !st.available);
    check('no liquid containers left', extContainers().length === 0, extContainers());
    check('no liquid volumes left (purge)', !docker('volume', 'ls', '--filter', 'label=cw.extension=liquid', '--format', '{{.Name}}'));
    const gw = await api('GET', '/gateway');
    check('no upstream owned by liquid left', !gw.upstreams.some((u) => ['onto'].includes(u.name)), gw.upstreams.map((u) => u.name));
  }
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err?.message ?? err);
  log(`ERROR ${result.error}`);
  process.exitCode = 1;
} finally {
  await shots?.close();
  result.finishedAt = new Date().toISOString();
  const dir = path.join(root, 'scripts', 'liquid', 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'm0b-extension-e2e.json'), JSON.stringify(result, null, 2));
  log(`result: scripts/liquid/results/m0b-extension-e2e.json (${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok)`);
}
