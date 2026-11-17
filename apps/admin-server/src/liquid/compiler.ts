import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CompileError, compileSources } from '@cw/ontology-compiler';
import type { OntologyIr } from '@cw/ontology-ir';

/*
 * Compiler and policy checks inside the control plane (ADR-0053; until then a separate Python container):
 *   - the ontology compiler is the TypeScript port (@cw/ontology-compiler), in-process;
 *   - `opa check --strict` + `opa test` and `opa build -t wasm` run the pinned static OPA binary of the control-plane
 *     image (OPA_BIN). Policies are files in a temporary directory; nothing is left behind.
 */

export const OPA_BIN = process.env.OPA_BIN ?? '/usr/local/bin/opa';
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}\.(rego|json)$/;
export const ENTRYPOINTS = ['liquid/gateway/decision', 'liquid/object/decision'];

type Issue = { path: string; message: string };

export function compileOntology(files: Record<string, string>): { ok: boolean; ir?: OntologyIr; errors?: Issue[] } {
  try {
    return { ok: true, ir: compileSources(files) };
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, errors: e.errors };
    return { ok: false, errors: [{ path: 'schema.yaml', message: (e as Error).message }] };
  }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd });
    let out = '';
    p.stdout.on('data', (b: Buffer) => (out += b.toString()));
    p.stderr.on('data', (b: Buffer) => (out += b.toString()));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (err) => {
      clearTimeout(t);
      resolve({ code: 127, out: String(err) });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, out });
    });
  });
}

function safePaths(files: Record<string, string>) {
  for (const k of Object.keys(files)) if (!SAFE_PATH.test(k) || k.split('/').includes('..')) throw Object.assign(new Error(`path not allowed: ${k}`), { status: 400 });
}

async function inTemp<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>, skip: (p: string) => boolean = () => false): Promise<T> {
  safePaths(files);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'liquid-opa-'));
  try {
    for (const [k, v] of Object.entries(files)) {
      if (skip(k)) continue;
      await mkdir(path.dirname(path.join(dir, k)), { recursive: true });
      await writeFile(path.join(dir, k), v);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const noOpa = (): Issue => ({ path: 'opa', message: `the OPA binary is not available at ${OPA_BIN} (control-plane image)` });

/** opa check --strict, then opa test: what a proposal touching policies/liquid/ must pass. */
export async function checkRego(files: Record<string, string>): Promise<{ ok: boolean; errors: Issue[] }> {
  safePaths(files);
  if (!existsSync(OPA_BIN)) return { ok: false, errors: [noOpa()] };
  return inTemp(files, async (dir) => {
    for (const step of [['check', '--strict'], ['test']]) {
      const r = await run(OPA_BIN, [...step, '.'], dir, 60_000);
      if (r.code !== 0) return { ok: false, errors: [{ path: `opa ${step[0]}`, message: r.out.trim().slice(0, 4000) }] };
    }
    return { ok: true, errors: [] };
  });
}

/** The single file `name` of a .tar.gz (ustar), without a tar dependency. */
export function fileFromTarGz(gz: Buffer, endsWith: string): Buffer | undefined {
  const tar = gunzipSync(gz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (name.endsWith(endsWith)) return Buffer.from(body);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/** opa build -t wasm with the two decision entrypoints (tests left out); the module as base64. */
export async function buildWasm(files: Record<string, string>): Promise<{ ok: boolean; wasm?: string; errors?: Issue[] }> {
  safePaths(files);
  if (!existsSync(OPA_BIN)) return { ok: false, errors: [noOpa()] };
  return inTemp(
    files,
    async (dir) => {
      const out = path.join(dir, '..', `${path.basename(dir)}.tar.gz`);
      try {
        const r = await run(OPA_BIN, ['build', '-t', 'wasm', ...ENTRYPOINTS.flatMap((e) => ['-e', e]), '-o', out, '.'], dir, 120_000);
        if (r.code !== 0) return { ok: false, errors: [{ path: 'opa build', message: r.out.trim().slice(0, 4000) }] };
        const wasm = fileFromTarGz(await readFile(out), 'policy.wasm');
        if (!wasm) return { ok: false, errors: [{ path: 'opa build', message: 'no policy.wasm in the bundle' }] };
        return { ok: true, wasm: wasm.toString('base64') };
      } finally {
        await rm(out, { force: true });
      }
    },
    (p) => p.endsWith('_test.rego'),
  );
}
