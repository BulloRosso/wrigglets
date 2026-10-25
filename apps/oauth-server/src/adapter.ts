import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Store } from './store.js';

/*
 * oidc-provider storage adapter.
 *  - `Client` is backed by the persistent Store (clients are administered by the admin plane).
 *  - Everything else (sessions, grants, codes, interactions, tokens) lives in memory with TTL.
 *    A restart of the OAuth server therefore signs everybody out of the OP (agents keep their
 *    own session cookies). On Azure use a shared store (ADR-0004).
 */

interface Entry {
  payload: AdapterPayload;
  expiresAt?: number;
}

const memory = new Map<string, Entry>();
const uidIndex = new Map<string, string>();
const userCodeIndex = new Map<string, string>();
const grantIndex = new Map<string, Set<string>>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (v.expiresAt && v.expiresAt < now) memory.delete(k);
}, 60_000).unref();

export function createAdapterClass(store: Store) {
  return class StoreAdapter implements Adapter {
    constructor(readonly name: string) {}

    private key(id: string) {
      return `${this.name}:${id}`;
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      if (this.name === 'Client') return;
      const key = this.key(id);
      memory.set(key, { payload, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined });
      if (payload.uid) uidIndex.set(payload.uid, key);
      if (payload.userCode) userCodeIndex.set(payload.userCode, key);
      if (payload.grantId) {
        const set = grantIndex.get(payload.grantId) ?? new Set<string>();
        set.add(key);
        grantIndex.set(payload.grantId, set);
      }
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      if (this.name === 'Client') {
        const c = store.findClient(id);
        if (!c) return undefined;
        return {
          client_id: c.clientId,
          client_secret: c.clientSecret,
          client_name: c.name,
          redirect_uris: c.redirectUris,
          post_logout_redirect_uris: c.postLogoutRedirectUris,
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_basic',
          cw_kind: c.kind,
          cw_agent_id: c.agentId,
        } as AdapterPayload;
      }
      const e = memory.get(this.key(id));
      if (!e) return undefined;
      if (e.expiresAt && e.expiresAt < Date.now()) {
        memory.delete(this.key(id));
        return undefined;
      }
      return e.payload;
    }

    async findByUid(uid: string) {
      const key = uidIndex.get(uid);
      return key ? memory.get(key)?.payload : undefined;
    }

    async findByUserCode(userCode: string) {
      const key = userCodeIndex.get(userCode);
      return key ? memory.get(key)?.payload : undefined;
    }

    async consume(id: string) {
      const e = memory.get(this.key(id));
      if (e) e.payload.consumed = Math.floor(Date.now() / 1000);
    }

    async destroy(id: string) {
      memory.delete(this.key(id));
    }

    async revokeByGrantId(grantId: string) {
      for (const key of grantIndex.get(grantId) ?? []) memory.delete(key);
      grantIndex.delete(grantId);
    }
  };
}

/** Ends every OP session of an account (used when a user is disabled or deleted). */
export function revokeSessionsOf(accountId: string): number {
  let n = 0;
  for (const [key, e] of memory) {
    if (key.startsWith('Session:') && e.payload.accountId === accountId) {
      memory.delete(key);
      n += 1;
    }
    if (key.startsWith('Grant:') && e.payload.accountId === accountId) memory.delete(key);
  }
  return n;
}

export function activeSessionCount(): number {
  let n = 0;
  const now = Date.now();
  for (const [key, e] of memory) if (key.startsWith('Session:') && (!e.expiresAt || e.expiresAt > now)) n += 1;
  return n;
}
