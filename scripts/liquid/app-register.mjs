#!/usr/bin/env node
// Registers an app folder in the app registry of Liquid Enterprise (ADR-0050), the way a person would:
//   1. download the app SDK of the ontology in force into <dir>/src/liquid-sdk.ts
//   2. build the app (vite build → dist/)
//   3. send the files (without node_modules) with the registration: owner, actions, reads, expiry
//   4. optionally activate it (the app gets its OIDC client and is served by the app host)
//
//   node scripts/liquid/app-register.mjs apps/liquid-app-due-diligence --id supplier-due-diligence \
//     --name "Supplier due diligence" --owner stefan.lang@sofaworks.example \
//     --actions submit_due_diligence_statement --reads Supplier,DueDiligenceStatement --activate
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, Session, env, log, root } from '../sofa-company/lib.mjs';

const SKIP = new Set(['node_modules', '.git', '.vite']);

export function collect(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      if (SKIP.has(name)) continue;
      const p = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(dir, p)).isDirectory()) walk(p);
      else out[p] = readFileSync(path.join(dir, p)).toString('base64');
    }
  };
  walk('');
  return out;
}

/** Steps 1–4 with a signed-in admin session. Returns the app record. */
export async function registerApp(s, o) {
  const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
  const dir = path.resolve(root, o.dir);
  const res = await s.raw(`${ADMIN}/api/liquid/ontology/sdk?kind=app`);
  if (!res.ok) throw new Error(`app SDK: HTTP ${res.status}`);
  writeFileSync(path.join(dir, 'src', 'liquid-sdk.ts'), await res.text());
  if (o.build !== false) {
    const b = spawnSync('corepack', ['pnpm', 'exec', 'vite', 'build', '--logLevel', 'warn'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
    if (b.status !== 0) throw new Error(`vite build failed: ${b.stderr || b.stdout}`);
  }
  const files = { ...collect(dir), ...(o.extraFiles ?? {}) };
  const app = await api('POST', '/liquid/apps', { id: o.id, name: o.name, description: o.description ?? '', owner: o.owner, actions: o.actions ?? [], reads: o.reads ?? [], source: o.source, expiresInDays: o.expiresInDays, files });
  if (o.activate && app.status === 'registered') return api('POST', `/liquid/apps/${o.id}/activate`);
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = argv[0];
  if (!dir || !opt('id') || !opt('name') || !opt('owner')) {
    console.error('usage: app-register.mjs <dir> --id <id> --name <name> --owner <email> [--actions a,b] [--reads A,B] [--source url] [--days n] [--activate]');
    process.exit(2);
  }
  const s = new Session();
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const app = await registerApp(s, { dir, id: opt('id'), name: opt('name'), owner: opt('owner'), description: opt('description'), actions: list(opt('actions')), reads: list(opt('reads')), source: opt('source'), expiresInDays: opt('days') ? Number(opt('days')) : undefined, activate: argv.includes('--activate') });
  log(`${app.id}: ${app.status} (version ${app.version}, expires ${app.expiresAt.slice(0, 10)})`);
  for (const c of app.checks) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.errors ? ` — ${c.errors.join('; ')}` : ''}`);
  if (app.status === 'active') log(`open ${app.url}`);
  process.exit(app.status === 'rejected' ? 1 : 0);
}
