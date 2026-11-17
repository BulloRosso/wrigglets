import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_CSP, createAppHost } from './appHost.js';
import type { AppRecord, AppRegistry } from './apps.js';

const rec = (status: AppRecord['status']): AppRecord => ({ id: 'dd', name: 'Due diligence', description: '', owner: 'ada@example.local', actions: ['submit_due_diligence_statement'], reads: ['Supplier'], version: 1, status, registeredBy: 'x', registeredAt: '', expiresAt: '2027-01-01T00:00:00Z', checks: [], checkedAt: '', ontologyVersion: '1', files: 1, bytes: 1, ...(status === 'active' ? { clientId: 'app-dd' } : {}) });

let server: Server | undefined;
afterEach(() => server?.close());

async function start(status: AppRecord['status']) {
  const registry = {
    list: () => [rec(status)],
    get: (id: string) => (id === 'dd' ? rec(status) : undefined),
    client: () => (status === 'active' ? { clientId: 'app-dd', clientSecret: 's'.repeat(32) } : undefined),
    distDir: () => '/nonexistent',
  } as unknown as AppRegistry;
  const host = createAppHost({ registry, appsPublicUrl: 'http://localhost:8090', issuer: 'http://localhost:9000', sessionSecret: 'x'.repeat(40), core: { url: () => 'http://127.0.0.1:1', token: () => 't' }, enabled: () => true });
  server = host.listen(0);
  await new Promise((r) => server!.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('app host (ADR-0050)', () => {
  it('serves every response with the strict CSP; unknown apps are 404', async () => {
    const base = await start('active');
    const r = await fetch(`${base}/apps/nope/`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-security-policy')).toBe(APP_CSP);
    expect(APP_CSP).toContain("connect-src 'self'");
    expect(APP_CSP).toContain("script-src 'self'");
  });

  it('an app that is not active answers 410 (registered, disabled, expired)', async () => {
    for (const s of ['registered', 'disabled', 'expired'] as const) {
      const base = await start(s);
      const r = await fetch(`${base}/apps/dd/`, { redirect: 'manual' });
      expect(r.status, s).toBe(410);
      expect(await r.text()).toContain(`not active (${s}`);
      server!.close();
    }
  });

  it('an active app: pages need a sign-in (redirect into the app path), the API answers 401 without a session', async () => {
    const base = await start('active');
    const slash = await fetch(`${base}/apps/dd`, { redirect: 'manual' });
    expect(slash.headers.get('location')).toBe('/apps/dd/');
    const pageRes = await fetch(`${base}/apps/dd/`, { redirect: 'manual' });
    expect(pageRes.status).toBe(302);
    expect(pageRes.headers.get('location')).toBe('/apps/dd/auth/login?returnTo=%2Fapps%2Fdd%2F');
    const apiRes = await fetch(`${base}/apps/dd/api/objects/Supplier`, { headers: { 'x-liquid-app': '1' } });
    expect(apiRes.status).toBe(401);
  });
});
