#!/usr/bin/env node
// Complete runtime test of Liquid Enterprise on the running stack: a fresh install from the console API (uninstall with
// purge first, restart of the control plane in the middle of the install), then every milestone suite in order.
//   node scripts/liquid/e2e-all.mjs [--shots] [--from <suite>]
// Writes scripts/liquid/results/e2e-all.json. Model tokens: none (agents are driven through their gateway tokens, no LLM).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? [] : ['--no-shots'];
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : undefined;
const suites = [
  ['M0b extension (fresh install, resume after restart)', 'e2e-extension.mjs', ['--keep', ...shots], 'm0b-extension-e2e.json'],
  ['M1 event log and lake', 'e2e-lake.mjs', shots, 'm1-lake-e2e.json'],
  ['M2 ontology and editor', 'e2e-ontology.mjs', shots, 'm2-ontology-e2e.json'],
  ['M3 backend swap', 'e2e-backend.mjs', [], 'm3-backend-e2e.json'],
  ['M4 policy (embedded)', 'e2e-policy.mjs', shots, 'm4-policy-e2e.json'],
  ['M5 business workflows', 'e2e-processes.mjs', shots, 'e2e-processes.json'],
  ['M6 config repository (Git host)', 'e2e-config.mjs', shots, 'e2e-config.json'],
  ['M7 playbooks', 'e2e-playbooks.mjs', shots, 'e2e-playbooks.json'],
  ['M8 ontology evolution', 'e2e-ontology-evolution.mjs', shots, 'e2e-ontology-evolution.json'],
];
const start = from ? Math.max(0, suites.findIndex((s) => s[1].includes(from))) : 0;
const out = { startedAt: new Date().toISOString(), suites: [] };
for (const [name, script, a, resultFile] of suites.slice(start)) {
  console.log(`\n=== ${name}: node scripts/liquid/${script} ${a.join(' ')}`);
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/liquid', script), ...a], { cwd: root, stdio: 'inherit', env: process.env });
  if (script === 'e2e-backend.mjs') spawnSync(process.execPath, [path.join(root, 'scripts/liquid/setup.mjs'), '--restore'], { cwd: root, stdio: 'inherit' });
  let checks;
  try {
    const res = JSON.parse(readFileSync(path.join(root, 'scripts/liquid/results', resultFile), 'utf8'));
    checks = { ok: (res.checks ?? []).filter((c) => c.ok).length, total: (res.checks ?? []).length };
  } catch {
    checks = undefined;
  }
  out.suites.push({ name, script, ok: r.status === 0, seconds: Math.round((Date.now() - t) / 1000), checks });
  if (r.status !== 0) break;
}
out.finishedAt = new Date().toISOString();
out.ok = out.suites.length === suites.length - start && out.suites.every((s) => s.ok);
mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
writeFileSync(path.join(root, 'scripts/liquid/results/e2e-all.json'), JSON.stringify(out, null, 2));
console.log('\n=== summary');
for (const s of out.suites) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name} (${s.checks ? `${s.checks.ok}/${s.checks.total}` : '?'}, ${s.seconds}s)`);
process.exit(out.ok ? 0 : 1);
