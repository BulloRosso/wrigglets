import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JWK } from 'oidc-provider';

interface Secrets {
  jwks: { keys: JWK[] };
  cookieKeys: string[];
}

/** Signing keys and cookie keys are generated on first start and persisted in DATA_DIR. */
export async function loadOrCreateSecrets(dataDir: string): Promise<Secrets> {
  const file = path.join(dataDir, 'secrets.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Secrets;
  } catch {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...(privateKey.export({ format: 'jwk' }) as JWK), kid: randomUUID(), alg: 'RS256', use: 'sig' };
    const secrets: Secrets = { jwks: { keys: [jwk] }, cookieKeys: [randomBytes(32).toString('base64url')] };
    await writeFile(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    return secrets;
  }
}
