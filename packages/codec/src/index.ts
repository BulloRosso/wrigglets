import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { METADATA_ENCODING_KEY, type Payload, type PayloadCodec } from '@temporalio/common';
import proto from '@temporalio/proto';

const { temporal } = proto;

/*
 * AES-256-GCM payload codec (spec §7.10).
 *
 * Keys are configured as `PAYLOAD_CODEC_KEYS="k2:<base64-32-bytes>,k1:<base64-32-bytes>"`.
 * The FIRST key encrypts; all keys can decrypt. The key id is stored in payload metadata so keys
 * can be rotated: add a new key in front, keep the old one until all histories are past retention.
 */

export const ENCODING = 'binary/encrypted';
const KEY_ID = 'encryption-key-id';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface CodecKey {
  id: string;
  key: Buffer;
}

export function parseCodecKeys(spec: string): CodecKey[] {
  const keys = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx <= 0) throw new Error('PAYLOAD_CODEC_KEYS entries must look like "<id>:<base64 key>"');
      const id = entry.slice(0, idx);
      const key = Buffer.from(entry.slice(idx + 1), 'base64');
      if (key.length !== 32) throw new Error(`Codec key "${id}" must be 32 bytes (base64 encoded)`);
      return { id, key };
    });
  if (keys.length === 0) throw new Error('At least one payload codec key is required');
  return keys;
}

export class AesGcmCodec implements PayloadCodec {
  private readonly byId: Map<string, Buffer>;
  private readonly current: CodecKey;

  constructor(keys: CodecKey[]) {
    this.current = keys[0]!;
    this.byId = new Map(keys.map((k) => [k.id, k.key]));
  }

  static fromSpec(spec: string): AesGcmCodec {
    return new AesGcmCodec(parseCodecKeys(spec));
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const plain = temporal.api.common.v1.Payload.encode(payload).finish();
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv(ALGO, this.current.key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        metadata: {
          [METADATA_ENCODING_KEY]: enc.encode(ENCODING),
          [KEY_ID]: enc.encode(this.current.id),
        },
        data: Buffer.concat([iv, body, tag]),
      };
    });
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.[METADATA_ENCODING_KEY];
      if (!encoding || dec.decode(encoding) !== ENCODING) return payload;
      const keyIdRaw = payload.metadata?.[KEY_ID];
      const keyId = keyIdRaw ? dec.decode(keyIdRaw) : undefined;
      const key = keyId ? this.byId.get(keyId) : undefined;
      if (!key) throw new Error(`Unknown payload codec key id "${keyId}"`);
      const data = Buffer.from(payload.data ?? new Uint8Array());
      const iv = data.subarray(0, IV_LEN);
      const tag = data.subarray(data.length - TAG_LEN);
      const body = data.subarray(IV_LEN, data.length - TAG_LEN);
      const decipher = createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      return temporal.api.common.v1.Payload.decode(plain);
    });
  }
}

/* ------------------------------------------------------------------ codec server */

/** JSON representation used by the Temporal Web UI / CLI remote codec protocol. */
interface JsonPayload {
  metadata?: Record<string, string>;
  data?: string;
}

const fromJson = (p: JsonPayload): Payload => ({
  metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64')])),
  data: p.data !== undefined ? Buffer.from(p.data, 'base64') : undefined,
});

const toJson = (p: Payload): JsonPayload => ({
  metadata: Object.fromEntries(
    Object.entries(p.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v as Uint8Array).toString('base64')]),
  ),
  data: p.data ? Buffer.from(p.data).toString('base64') : undefined,
});

/**
 * Implements `POST /encode` and `POST /decode` of the remote codec protocol:
 * request and response body are `{ "payloads": [ { metadata: {k: base64}, data: base64 } ] }`.
 */
export async function handleCodecRequest(
  codec: PayloadCodec,
  op: 'encode' | 'decode',
  body: unknown,
): Promise<{ payloads: JsonPayload[] }> {
  const payloads = ((body as { payloads?: JsonPayload[] } | undefined)?.payloads ?? []).map(fromJson);
  const out = op === 'encode' ? await codec.encode(payloads) : await codec.decode(payloads);
  return { payloads: out.map(toJson) };
}

/** Generates a random key spec entry, e.g. for `.env` bootstrap. */
export const generateCodecKey = (id = 'k1') => `${id}:${randomBytes(32).toString('base64')}`;
