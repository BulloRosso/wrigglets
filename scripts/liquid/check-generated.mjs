#!/usr/bin/env node
// Stale check (plan M2, run by scripts/liquid/check.mjs): fails if an ontology source changed without rebuilding the IR,
// or if the committed IR is not exactly what the compiler produces (nothing else is generated since ADR-0053).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (t) => createHash('sha256').update(t.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
let failed = false;
const { compileDir, dumpsIr } = await import(pathToFileURL(path.join(root, 'packages/ontology-compiler/dist/index.js')).href);

for (const d of readdirSync(path.join(root, 'ontology'), { withFileTypes: true })) {
  if (!d.isDirectory() || !existsSync(path.join(root, 'ontology', d.name, 'schema.yaml'))) continue;
  const irPath = path.join(root, 'packages', `ontology-${d.name}`, 'ir', 'ontology.ir.json');
  if (!existsSync(irPath)) {
    console.error(`ontology ${d.name}: no IR at ${path.relative(root, irPath)} — run node scripts/liquid/ontology-build.mjs`);
    failed = true;
    continue;
  }
  const text = readFileSync(irPath, 'utf8').split('\r\n').join('\n');
  const ir = JSON.parse(text);
  const stale = Object.entries(ir.source.files).filter(([f, h]) => sha(readFileSync(path.join(root, 'ontology', d.name, f), 'utf8')) !== h).map(([f]) => f);
  if (stale.length) {
    console.error(`ontology ${d.name}: ${stale.join(', ')} changed after the IR was compiled — run node scripts/liquid/ontology-build.mjs`);
    failed = true;
  } else if (dumpsIr(compileDir(path.join(root, 'ontology', d.name))) !== text) {
    // the committed IR must be exactly what the compiler produces from the sources (ADR-0053)
    console.error(`ontology ${d.name}: the committed IR differs from what the compiler produces — run node scripts/liquid/ontology-build.mjs`);
    failed = true;
  } else console.log(`ontology ${d.name}: IR matches its sources and the compiler (${ir.hash.slice(0, 12)})`);
}
process.exit(failed ? 1 : 0);
