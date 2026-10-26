import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompactEncrypt, compactDecrypt } from 'jose';

export interface UserTokens {
  /** Access token for the agent's own API (`api://<client>/access_as_user`) — the OBO assertion. */
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  upn?: string;
}

/**
 * Per-user Entra tokens of this agent, encrypted at rest (A256GCM, key derived from the session secret).
 * They live only here: never in cookies, Temporal history, workflow input or logs. One file per user.
 */
export class UserTokenStore {
  private readonly key: Buffer;
  private readonly cache = new Map<string, UserTokens>();

  constructor(
    private readonly dir: string,
    secret: string,
  ) {
    this.key = createHash('sha256').update(`obo-token-store:${secret}`).digest();
  }

  private file(oid: string) {
    return path.join(this.dir, `${createHash('sha256').update(oid).digest('hex')}.jwe`);
  }

  async put(oid: string, t: UserTokens) {
    this.cache.set(oid, t);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const jwe = await new CompactEncrypt(Buffer.from(JSON.stringify(t))).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(this.key);
    await writeFile(`${this.file(oid)}.tmp`, jwe, { mode: 0o600 });
    await rename(`${this.file(oid)}.tmp`, this.file(oid));
  }

  async get(oid: string): Promise<UserTokens | undefined> {
    const hit = this.cache.get(oid);
    if (hit) return hit;
    try {
      const { plaintext } = await compactDecrypt(await readFile(this.file(oid), 'utf8'), this.key);
      const t = JSON.parse(Buffer.from(plaintext).toString('utf8')) as UserTokens;
      this.cache.set(oid, t);
      return t;
    } catch {
      return undefined; // missing, or unreadable with the current secret → the user signs in again
    }
  }

  async delete(oid: string) {
    this.cache.delete(oid);
    await rm(this.file(oid), { force: true });
  }
}
