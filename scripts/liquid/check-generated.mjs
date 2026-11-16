#!/usr/bin/env node
// Stale check (plan M2, run by scripts/liquid/check.mjs): fails if an ontology source changed without rebuilding the IR,
// or if a generated file differs from what the generators produce from the committed IR. Needs no Docker.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (t) => createHash('sha256').update(t.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
let failed = false;

for (const d of readdirSync(path.join(root, 'ontology'), { withFileTypes: true })) {
  if (!d.isDirectory() || !existsSync(path.join(root, 'ontology', d.name, 'schema.yaml'))) continue;
  const irPath = path.join(root, 'packages', `ontology-${d.name}`, 'ir', 'ontology.ir.json');
  if (!existsSync(irPath)) {
    console.error(`ontology ${d.name}: no IR at ${path.relative(root, irPath)} — run node scripts/liquid/ontology-build.mjs`);
    failed = true;
    continue;
  }
  const ir = JSON.parse(readFileSync(irPath, 'utf8'));
  const stale = Object.entries(ir.source.files).filter(([f, h]) => sha(readFileSync(path.join(root, 'ontology', d.name, f), 'utf8')) !== h).map(([f]) => f);
  if (stale.length) {
    console.error(`ontology ${d.name}: ${stale.join(', ')} changed after the IR was compiled — run node scripts/liquid/ontology-build.mjs`);
    failed = true;
  } else console.log(`ontology ${d.name}: IR matches its sources (${ir.hash.slice(0, 12)})`);
  const r = spawnSync(process.execPath, [path.join(root, 'packages/ontology-codegen/dist/cli.js'), path.join(root, 'packages', `ontology-${d.name}`), '--check'], { encoding: 'utf8' });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
