#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { verifyIr } from '@cw/ontology-ir';
import { generateAll } from './index.js';

/*
 *   ontology-codegen <package dir>           read <dir>/ir/ontology.ir.json, write every generated file
 *   ontology-codegen <package dir> --check   exit 1 if a generated file is missing or differs (stale check)
 */
const [dir, flag] = process.argv.slice(2);
if (!dir) {
  console.error('usage: ontology-codegen <package dir> [--check]');
  process.exit(2);
}
const ir = verifyIr(JSON.parse(readFileSync(path.join(dir, 'ir', 'ontology.ir.json'), 'utf8')));
const files = generateAll(ir);
const stale: string[] = [];
for (const [rel, content] of Object.entries(files)) {
  const p = path.join(dir, rel);
  const current = existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : undefined;
  if (current === content) continue;
  if (flag === '--check') stale.push(rel);
  else {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    console.log(`wrote ${rel}`);
  }
}
if (flag === '--check') {
  if (stale.length) {
    console.error(`generated files are stale (${stale.join(', ')}): run node scripts/liquid/ontology-build.mjs`);
    process.exit(1);
  }
  console.log(`generated files of ${ir.name}@${ir.version} are up to date`);
}
