import { describe, expect, it } from 'vitest';
import { defaultPayloadConverter } from '@temporalio/common';
import { AesGcmCodec, generateCodecKey, handleCodecRequest, parseCodecKeys } from './index.js';

describe('AesGcmCodec', () => {
  it('round-trips payloads and hides the plaintext', async () => {
    const codec = AesGcmCodec.fromSpec(generateCodecKey('k1'));
    const payload = defaultPayloadConverter.toPayload({ secret: 'offer 4711' });
    const [encoded] = await codec.encode([payload]);
    expect(Buffer.from(encoded!.data!).toString('utf8')).not.toContain('offer 4711');
    const [decoded] = await codec.decode([encoded!]);
    expect(defaultPayloadConverter.fromPayload(decoded!)).toEqual({ secret: 'offer 4711' });
  });

  it('decrypts with an older key after rotation', async () => {
    const k1 = generateCodecKey('k1');
    const old = AesGcmCodec.fromSpec(k1);
    const rotated = AesGcmCodec.fromSpec(`${generateCodecKey('k2')},${k1}`);
    const [encoded] = await old.encode([defaultPayloadConverter.toPayload(42)]);
    const [decoded] = await rotated.decode([encoded!]);
    expect(defaultPayloadConverter.fromPayload(decoded!)).toBe(42);
  });

  it('passes through payloads that are not encrypted', async () => {
    const codec = AesGcmCodec.fromSpec(generateCodecKey());
    const plain = defaultPayloadConverter.toPayload('hello');
    expect(await codec.decode([plain])).toEqual([plain]);
  });

  it('rejects malformed key specs', () => {
    expect(() => parseCodecKeys('nokey')).toThrow();
    expect(() => parseCodecKeys('k1:dG9vc2hvcnQ=')).toThrow(/32 bytes/);
  });

  it('implements the remote codec JSON protocol', async () => {
    const codec = AesGcmCodec.fromSpec(generateCodecKey());
    const p = defaultPayloadConverter.toPayload({ a: 1 });
    const json = {
      payloads: [
        {
          metadata: Object.fromEntries(Object.entries(p.metadata!).map(([k, v]) => [k, Buffer.from(v).toString('base64')])),
          data: Buffer.from(p.data!).toString('base64'),
        },
      ],
    };
    const encoded = await handleCodecRequest(codec, 'encode', json);
    expect(Buffer.from(encoded.payloads[0]!.metadata!.encoding!, 'base64').toString()).toBe('binary/encrypted');
    const decoded = await handleCodecRequest(codec, 'decode', encoded);
    expect(decoded).toEqual(json);
  });
});
