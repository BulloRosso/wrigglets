#!/usr/bin/env node
// Writes the fixtures `opa test` needs next to policies/ (ontology data + generated ontology test) into a directory.
// Since ADR-0049 they are computed from the IR, not committed:  node scripts/liquid/opa-fixtures.mjs <dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.resolve(process.argv[2] ?? path.join(root, '.local', 'opa-fixtures'));
const { opaTestFixtures } = await import(new URL('../../packages/ontology-codegen/dist/index.js', import.meta.url).href);
const ir = JSON.parse(readFileSync(path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json'), 'utf8'));
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(opaTestFixtures(ir))) writeFileSync(path.join(out, name), content);
console.log(`opa fixtures written to ${out}`);
