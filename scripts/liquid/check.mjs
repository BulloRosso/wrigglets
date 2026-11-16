#!/usr/bin/env node
// Local CI-like check for the Liquid Enterprise work (plan §0, M0 task 5).
//   node scripts/liquid/check.mjs            build, typecheck, tests, opa test (if policies exist), stale check (if present)
//   node scripts/liquid/check.mjs --no-build skip the build step
// Runs the per-package scripts through corepack, so `pnpm` does not have to be on PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const pnpm = (...a) => ['corepack', ['pnpm', '-r', '--filter', '!coworking-agents', ...a]];

const steps = [];
if (!args.has('--no-build')) steps.push(['build', ...pnpm('--workspace-concurrency=4', 'run', 'build')]);
steps.push(['typecheck', ...pnpm('run', 'typecheck')]);
steps.push(['test', ...pnpm('--workspace-concurrency=1', 'run', 'test')]);
// OPA policies (ADR-0044) with the generated ontology data, in the pinned OPA image (no local opa binary needed)
export const OPA_IMAGE = 'openpolicyagent/opa:1.22.0-static@sha256:906bfc9904b2693733e7959d71773dd073e6c135cf06f26d955abe94603e82b3';
if (existsSync(path.join(root, 'policies', 'liquid'))) {
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).stdout?.trim();
  if (docker) steps.push(['opa test', 'docker', ['run', '--rm', '-v', `${root.split(path.sep).join('/')}:/w:ro`, '-w', '/w', OPA_IMAGE, 'test', 'policies', 'packages/ontology-sofa/generated/opa']]);
  else console.log('note: Docker is not running, skipping opa test');
}
if (existsSync(path.join(root, 'scripts', 'liquid', 'check-generated.mjs'))) steps.push(['generated files up to date', 'node', ['scripts/liquid/check-generated.mjs']]);

const results = [];
for (const [name, cmd, cmdArgs] of steps) {
  console.log(`\n=== ${name}: ${cmd} ${cmdArgs.join(' ')}`);
  const t = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && cmd !== 'docker', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const ok = r.status === 0;
  results.push({ name, ok, seconds: Math.round((Date.now() - t) / 1000), error: r.error?.message });
  if (!ok) break;
}

console.log('\n=== summary');
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.seconds}s)${r.error ? ` – ${r.error}` : ''}`);
const skipped = steps.slice(results.length).map((s) => s[0]);
if (skipped.length) console.log(`skipped after failure: ${skipped.join(', ')}`);
process.exit(results.every((r) => r.ok) && !skipped.length ? 0 : 1);
