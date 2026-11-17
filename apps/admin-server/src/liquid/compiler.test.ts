import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { OPA_BIN, buildWasm, checkRego, compileOntology, fileFromTarGz } from './compiler.js';

/** A minimal ustar archive with the given files. */
function tarGz(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('ustar\0', 257);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('control-plane compiler (ADR-0053)', () => {
  it('reads one file out of a .tar.gz bundle', () => {
    const gz = tarGz({ '/data.json': Buffer.from('{}'), '/policy.wasm': Buffer.from([0, 0x61, 0x73, 0x6d, 1]) });
    expect(fileFromTarGz(gz, 'policy.wasm')).toEqual(Buffer.from([0, 0x61, 0x73, 0x6d, 1]));
    expect(fileFromTarGz(gz, 'nope.wasm')).toBeUndefined();
  });

  it('compiles an ontology in-process and returns errors as data', () => {
    expect(compileOntology({ 'schema.yaml': 'name: x', 'actions.yaml': '', 'bindings.yaml': '' })).toMatchObject({ ok: false, errors: expect.arrayContaining([{ path: 'schema.yaml#version', message: 'version must be semver (x.y.z)' }]) });
  });

  it('refuses path traversal; without the OPA binary it fails closed with a clear error', async () => {
    await expect(checkRego({ 'a/../../x.rego': 'package x' })).rejects.toThrow(/path not allowed/);
    if (!existsSync(OPA_BIN)) {
      expect(await checkRego({ 'x.rego': 'package x' })).toEqual({ ok: false, errors: [{ path: 'opa', message: expect.stringContaining('not available') }] });
    }
  });

  it.runIf(existsSync(OPA_BIN))('opa check + test and opa build -t wasm (in the image)', async () => {
    const policy = 'package x\nimport rego.v1\nallow if input.a == 1\n';
    const test = (a: number) => `package x_test\nimport rego.v1\nimport data.x\ntest_a if x.allow with input as {"a": ${a}}\n`;
    expect(await checkRego({ 'x.rego': policy, 'x_test.rego': test(1) })).toEqual({ ok: true, errors: [] });
    expect((await checkRego({ 'x.rego': policy, 'x_test.rego': test(2) })).errors[0]?.path).toBe('opa test');
    const wasm = await buildWasm({
      'liquid/gateway/g.rego': 'package liquid.gateway\nimport rego.v1\ndecision := {"allow": input.a == 1, "reason": "x", "obligations": []}\n',
      'liquid/object/o.rego': 'package liquid.object\nimport rego.v1\ndecision := {"allow": true, "reason": "x", "obligations": []}\n',
      'liquid/object/o_test.rego': 'package liquid.object_test\nbroken {',
    });
    expect(wasm.ok).toBe(true);
    expect(Buffer.from(wasm.wasm!, 'base64').subarray(0, 4)).toEqual(Buffer.from([0, 0x61, 0x73, 0x6d]));
  });
});
