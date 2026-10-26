import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EntraClient, EntraError } from '../src/obo/entraClient.js';
import { OboService } from '../src/obo/oboService.js';
import { mountObo } from '../src/obo/route.js';
import { UserTokenStore } from '../src/obo/userTokenStore.js';

/* A fake Entra v2.0 token endpoint that records the form fields it receives. */
let server: Server;
let base: string;
let seen: Array<Record<string, string>> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ _path: req.url ?? '', ...Object.fromEntries(new URLSearchParams(raw)) });
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());
beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } };
});

const client = (credential: ConstructorParameters<typeof EntraClient>[0]['credential'] = { kind: 'secret', secret: 'shh' }) =>
  new EntraClient({ authorityHost: base, tenantId: 'tenant-1', clientId: 'agent-app', credential });

/** A throwaway self-signed certificate + key (PEM), or undefined without openssl. */
async function testCertPem(): Promise<string | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=agent-test', '-days', '1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    return `${await readFile(path.join(dir, 'c.pem'), 'utf8')}\n${await readFile(path.join(dir, 'k.pem'), 'utf8')}`;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('EntraClient', () => {
  it('performs the On-Behalf-Of exchange as the agent application', async () => {
    const t = await client().onBehalfOf('user-assertion', 'api://crm/.default');
    expect(t.accessToken).toBe('tok-1');
    expect(seen[0]).toMatchObject({
      _path: '/tenant-1/oauth2/v2.0/token',
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      requested_token_use: 'on_behalf_of',
      assertion: 'user-assertion',
      scope: 'api://crm/.default',
      client_id: 'agent-app',
      client_secret: 'shh',
    });
  });

  it('uses client credentials without any user assertion for agent-only tokens', async () => {
    await client().clientCredentials('api://crm/.default');
    expect(seen[0]).toMatchObject({ grant_type: 'client_credentials', scope: 'api://crm/.default' });
    expect(seen[0]).not.toHaveProperty('assertion');
  });

  it('authenticates with a signed client assertion for certificate credentials', async () => {
    const pem = await testCertPem();
    if (!pem) return; // openssl not available
    await client({ kind: 'cert', pem }).clientCredentials('s');
    const assertion = seen[0]!.client_assertion!;
    expect(seen[0]).toMatchObject({ client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' });
    expect(seen[0]).not.toHaveProperty('client_secret');
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: 'RS256' });
    expect(decodeProtectedHeader(assertion)['x5t#S256']).toBeTruthy();
    expect(decodeJwt(assertion)).toMatchObject({ iss: 'agent-app', sub: 'agent-app', aud: `${base}/tenant-1/oauth2/v2.0/token` });
  });

  it('sends the federated assertion read from the token file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fed-'));
    const file = path.join(dir, 'token');
    await writeFile(file, 'fed-jwt\n');
    await client({ kind: 'federated', tokenFile: file }).clientCredentials('s');
    expect(seen[0]).toMatchObject({ client_assertion: 'fed-jwt', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' });
    expect(seen[0]).not.toHaveProperty('client_secret');
    await rm(dir, { recursive: true });
  });

  it('reports only the OAuth error code and flags errors that need the user', async () => {
    reply = { status: 400, body: { error: 'invalid_grant', error_description: 'secret details AADSTS70008' } };
    const err = await client().refresh('r', 's').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntraError);
    expect((err as EntraError).code).toBe('invalid_grant');
    expect((err as EntraError).needsUserInteraction).toBe(true);
    expect(String(err)).not.toContain('AADSTS');
  });
});

describe('UserTokenStore', () => {
  it('encrypts tokens at rest and survives a restart; a different secret cannot read them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'obo-'));
    const s1 = new UserTokenStore(dir, 'secret-one');
    await s1.put('oid-1', { accessToken: 'AT-plain', refreshToken: 'RT-plain', expiresAt: 123 });
    const [file] = await readdir(dir);
    const raw = await readFile(path.join(dir, file!), 'utf8');
    expect(raw).not.toContain('AT-plain');
    expect(raw).not.toContain('RT-plain');
    expect(await new UserTokenStore(dir, 'secret-one').get('oid-1')).toMatchObject({ accessToken: 'AT-plain', refreshToken: 'RT-plain' });
    expect(await new UserTokenStore(dir, 'other').get('oid-1')).toBeUndefined();
    await s1.delete('oid-1');
    expect(await new UserTokenStore(dir, 'secret-one').get('oid-1')).toBeUndefined();
    await rm(dir, { recursive: true });
  });
});

describe('OboService', () => {
  const NOW = 1_000_000;
  const mk = (over: { allowAgentOnly?: boolean } = {}) => {
    const calls: string[] = [];
    const memory = new Map<string, { accessToken: string; refreshToken?: string; expiresAt: number }>();
    const entra = {
      onBehalfOf: async (a: string, s: string) => (calls.push(`obo:${a}:${s}`), { accessToken: `obo-${a}`, expiresAt: NOW + 3_600_000 }),
      clientCredentials: async (s: string) => (calls.push(`cc:${s}`), { accessToken: 'agent-tok', expiresAt: NOW + 3_600_000 }),
      refresh: async (r: string) => {
        calls.push(`refresh:${r}`);
        if (r === 'revoked') throw new EntraError('invalid_grant', 400);
        return { accessToken: 'AT-new', refreshToken: 'RT-new', expiresAt: NOW + 3_600_000 };
      },
    };
    const store = {
      get: async (o: string) => memory.get(o),
      put: async (o: string, t: { accessToken: string; refreshToken?: string; expiresAt: number }) => void memory.set(o, t),
      delete: async (o: string) => void memory.delete(o),
    };
    const svc = new OboService(entra, store, { userScope: 'api://agent/access_as_user', allowAgentOnly: over.allowAgentOnly ?? false }, () => NOW);
    return { svc, calls, memory };
  };

  it('exchanges the stored user token and caches the result', async () => {
    const { svc, calls } = mk();
    await svc.saveSignIn('u1', { accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW + 3_600_000 });
    const a = await svc.token({ mode: 'obo', scope: 'api://crm/.default', oid: 'u1' });
    const b = await svc.token({ mode: 'obo', scope: 'api://crm/.default', oid: 'u1' });
    expect(a).toMatchObject({ ok: true, accessToken: 'obo-AT', mode: 'obo' });
    expect(b).toEqual(a);
    expect(calls.filter((c) => c.startsWith('obo:'))).toHaveLength(1);
  });

  it('never mixes users or scopes in the cache', async () => {
    const { svc, calls } = mk();
    await svc.saveSignIn('u1', { accessToken: 'AT1', expiresAt: NOW + 3_600_000 });
    await svc.saveSignIn('u2', { accessToken: 'AT2', expiresAt: NOW + 3_600_000 });
    expect(await svc.token({ mode: 'obo', scope: 'a', oid: 'u1' })).toMatchObject({ accessToken: 'obo-AT1' });
    expect(await svc.token({ mode: 'obo', scope: 'a', oid: 'u2' })).toMatchObject({ accessToken: 'obo-AT2' });
    expect(await svc.token({ mode: 'obo', scope: 'b', oid: 'u1' })).toMatchObject({ accessToken: 'obo-AT1' });
    expect(calls).toHaveLength(3);
  });

  it('refreshes an expired user token and forgets a revoked grant (no downgrade to agent-only)', async () => {
    const { svc, memory } = mk({ allowAgentOnly: true });
    await svc.saveSignIn('u1', { accessToken: 'old', refreshToken: 'RT', expiresAt: NOW - 1 });
    expect(await svc.token({ mode: 'obo', scope: 's', oid: 'u1' })).toMatchObject({ ok: true, accessToken: 'obo-AT-new' });
    expect(memory.get('u1')).toMatchObject({ accessToken: 'AT-new', refreshToken: 'RT-new' });
    await svc.saveSignIn('u2', { accessToken: 'old', refreshToken: 'revoked', expiresAt: NOW - 1 });
    expect(await svc.token({ mode: 'obo', scope: 's', oid: 'u2' })).toMatchObject({ ok: false, code: 'no_user_assertion' });
    expect(memory.has('u2')).toBe(false);
    expect(await svc.token({ mode: 'obo', scope: 's' })).toMatchObject({ ok: false, code: 'no_user_assertion' });
  });

  it('issues agent-only tokens only when the agent allows it', async () => {
    expect(await mk().svc.token({ mode: 'agent-only', scope: 's' })).toMatchObject({ ok: false, code: 'agent_only_not_allowed' });
    const { svc, calls } = mk({ allowAgentOnly: true });
    expect(await svc.token({ mode: 'agent-only', scope: 's' })).toMatchObject({ ok: true, accessToken: 'agent-tok', mode: 'agent-only' });
    expect(calls).toEqual(['cc:s']);
  });
});

describe('POST /internal/obo-token', () => {
  const app = (obo: OboService | undefined) => {
    const a = express();
    mountObo(a, obo, 'gw-token');
    return a;
  };
  const post = async (a: express.Express, body: unknown, token = 'gw-token') => {
    const s = a.listen(0);
    await new Promise((r) => s.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/internal/obo-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, cache: res.headers.get('cache-control'), json: (await res.json()) as Record<string, unknown> };
    } finally {
      s.close();
    }
  };
  const fakeObo = (r: Awaited<ReturnType<OboService['token']>>) => ({ token: async () => r }) as unknown as OboService;
  const ok = { ok: true, accessToken: 'tok', expiresAt: 5, mode: 'obo' } as const;

  it('only answers the gateway', async () => {
    expect((await post(app(fakeObo(ok)), { mode: 'obo', scope: 's', oid: 'u' }, 'wrong')).status).toBe(401);
  });
  it('returns 404 when the capability is off, without any token', async () => {
    const r = await post(app(undefined), { mode: 'obo', scope: 's', oid: 'u' });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.json)).not.toContain('accessToken');
  });
  it('maps results to status codes and forbids caching', async () => {
    expect(await post(app(fakeObo(ok)), { mode: 'obo', scope: 's', oid: 'u' })).toMatchObject({ status: 200, cache: 'no-store', json: { accessToken: 'tok', mode: 'obo' } });
    expect((await post(app(fakeObo({ ok: false, code: 'no_user_assertion', message: 'm' })), { mode: 'obo', scope: 's', oid: 'u' })).status).toBe(401);
    expect((await post(app(fakeObo({ ok: false, code: 'agent_only_not_allowed', message: 'm' })), { mode: 'agent-only', scope: 's' })).status).toBe(403);
    expect((await post(app(fakeObo(ok)), { mode: 'bogus' })).status).toBe(400);
  });
});
