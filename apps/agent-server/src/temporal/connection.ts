import { readFileSync, existsSync } from 'node:fs';
import { Client, Connection, type ConnectionOptions } from '@temporalio/client';
import { NativeConnection, type NativeConnectionOptions } from '@temporalio/worker';
import type { DataConverter } from '@temporalio/common';
import { AesGcmCodec } from '@cw/codec';
import type { Config } from '../config.js';

/** Accepts either PEM content or a file path (Key Vault references deliver content). */
function pem(value?: string): Buffer | undefined {
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return Buffer.from(value.replace(/\\n/g, '\n'));
  if (existsSync(value)) return readFileSync(value);
  throw new Error(`TLS material not found: ${value}`);
}

export function tlsOptions(config: Config): ConnectionOptions['tls'] {
  const cert = pem(config.TEMPORAL_TLS_CERT);
  const key = pem(config.TEMPORAL_TLS_KEY);
  const ca = pem(config.TEMPORAL_TLS_CA);
  if (!cert && !key && !ca) return undefined; // local dev server: plaintext
  return {
    serverNameOverride: config.TEMPORAL_TLS_SERVER_NAME,
    serverRootCACertificate: ca,
    clientCertPair: cert && key ? { crt: cert, key } : undefined,
  };
}

export function createDataConverter(config: Config): DataConverter {
  return { payloadCodecs: [AesGcmCodec.fromSpec(config.PAYLOAD_CODEC_KEYS)] };
}

export async function connectClient(config: Config, dataConverter: DataConverter): Promise<Client> {
  const connection = await Connection.connect({ address: config.TEMPORAL_ADDRESS, tls: tlsOptions(config) });
  return new Client({ connection, namespace: config.TEMPORAL_NAMESPACE, dataConverter });
}

export async function connectWorker(config: Config): Promise<NativeConnection> {
  return NativeConnection.connect({
    address: config.TEMPORAL_ADDRESS,
    tls: tlsOptions(config) as NativeConnectionOptions['tls'],
  });
}
