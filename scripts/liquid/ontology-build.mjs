#!/usr/bin/env node
// Builds every ontology under ontology/<name>: LinkML compiler (pinned container) -> packages/ontology-<name>/ir/
// ontology.ir.json -> generators -> packages/ontology-<name>/{src/generated,generated}. Deterministic: run it twice and
// nothing changes (--verify compiles twice and compares the hashes).
//
//   node scripts/liquid/ontology-build.mjs [--verify] [--rebuild-compiler] [--codegen-only]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const IMAGE = 'coworking/ontology-compiler:local';
const win = process.platform === 'win32';

function run(cmd, a, opts = {}) {
  const r = spawnSync(cmd, a, { cwd: root, encoding: 'utf8', shell: win && cmd !== 'docker', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || String(r.error));
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}

const ontologies = readdirSync(path.join(root, 'ontology'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(root, 'ontology', d.name, 'schema.yaml')))
  .map((d) => d.name);

if (!args.has('--codegen-only')) {
  const have = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status === 0;
  if (!have || args.has('--rebuild-compiler')) {
    console.log(`building ${IMAGE}`);
    run('docker', ['build', '-q', '-f', 'infra/docker/ontology-compiler.Dockerfile', '-t', IMAGE, '.']);
  }
  for (const name of ontologies) {
    const src = path.join(root, 'ontology', name).replace(/\\/g, '/');
    const compile = () => run('docker', ['run', '--rm', '-v', `${src}:/src:ro`, IMAGE, 'compile', '/src', '-o', '-']);
    const ir = compile();
    if (args.has('--verify')) {
      const again = compile();
      if (again !== ir) {
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

run('corepack', ['pnpm', '--filter', '@cw/ontology-ir', '--filter', '@cw/ontology-codegen', 'run', 'build']);
for (const name of ontologies) {
  process.stdout.write(run('node', ['packages/ontology-codegen/dist/cli.js', `packages/ontology-${name}`]) || `ontology ${name}: generated files unchanged\n`);
}
