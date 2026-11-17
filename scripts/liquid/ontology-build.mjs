#!/usr/bin/env node
// Builds every ontology under ontology/<name> with the TypeScript compiler (@cw/ontology-compiler, ADR-0053) into
// packages/ontology-<name>/ir/ontology.ir.json. Deterministic: --verify compiles twice and compares. No Docker, no
// Python, no generated code (everything else is computed from the IR at runtime).
//
//   node scripts/liquid/ontology-build.mjs [--verify]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const win = process.platform === 'win32';

function run(cmd, a) {
  const r = spawnSync(cmd, a, { cwd: root, encoding: 'utf8', shell: win, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || String(r.error));
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}

const ontologies = readdirSync(path.join(root, 'ontology'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(root, 'ontology', d.name, 'schema.yaml')))
  .map((d) => d.name);

run('corepack', ['pnpm', '--filter', '@cw/ontology-ir', '--filter', '@cw/ontology-compiler', 'run', 'build']);
const { CompileError, compileDir, dumpsIr } = await import(pathToFileURL(path.join(root, 'packages/ontology-compiler/dist/index.js')).href);

{
  for (const name of ontologies) {
    const compile = () => {
      try {
        return dumpsIr(compileDir(path.join(root, 'ontology', name)));
      } catch (e) {
        if (e instanceof CompileError) for (const x of e.errors) console.error(`error: ${x.path}: ${x.message}`);
        else console.error(String(e));
        process.exit(1);
      }
    };
    const ir = compile();
    if (args.has('--verify')) {
      if (compile() !== ir) {
        console.error(`ontology ${name}: two compiler runs differ — the build is not deterministic`);
        process.exit(1);
      }
      console.log(`ontology ${name}: deterministic (hash ${JSON.parse(ir).hash.slice(0, 12)} twice)`);
    }
    const out = path.join(root, 'packages', `ontology-${name}`, 'ir', 'ontology.ir.json');
    mkdirSync(path.dirname(out), { recursive: true });
    const before = existsSync(out) ? readFileSync(out, 'utf8') : '';
    writeFileSync(out, ir);
    const j = JSON.parse(ir);
    console.log(`ontology ${name}@${j.version}: ${j.classes.length} classes, ${j.actions.length} actions, hash ${j.hash.slice(0, 12)}${before === ir ? ' (unchanged)' : ''}`);
  }
}

