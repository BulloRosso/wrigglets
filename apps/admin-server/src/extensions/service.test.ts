import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpstreamServer } from '@cw/shared';
import { extensionManifest, type ExtensionManifestInput, type ServiceSpec } from '@cw/extensions';
import { liquidManifest } from './liquid.js';
import { parseState, type ExtensionRuntime, type ManagedContainer } from './runtime.js';
import { ExtensionService } from './service.js';

/** In-memory Docker: containers per extension, volumes, images; records every call. */
class FakeRuntime implements ExtensionRuntime {
  containers = new Map<string, ManagedContainer & { env: Record<string, string>; ext: string }>();
  volumes = new Set<string>();
  images = new Set<string>(['postgres:17', 'cw/server:local']);
  calls: string[] = [];
  failRun?: string;
  /** Number of list() calls during which a new container still reports "starting". */
  startingPolls = 0;
  private polls = new Map<string, number>();

  async ping() {
    return { ok: true, detail: 'fake' };
  }
  execs: string[] = [];
  async exec(ext: string, service: string, cmd: string[]) {
    this.execs.push(`cw-ext-${ext}-${service}: ${cmd.join(' ')}`);
    return { code: 0, output: 'ok' };
  }
  imageIds = new Map<string, string>();
  async imagePresent(ref: string) {
    return this.images.has(ref);
  }
  async imageId(ref: string) {
    return this.images.has(ref) ? (this.imageIds.get(ref) ?? `sha256:${ref}`) : undefined;
  }
  async pullImage(ref: string) {
    this.calls.push(`pull ${ref}`);
    this.images.add(ref);
  }
  async ensureVolume(ext: string, vol: string) {
    this.volumes.add(`${ext}/${vol}`);
  }
  async removeVolume(ext: string, vol: string) {
    this.calls.push(`rmvol ${vol}`);
    this.volumes.delete(`${ext}/${vol}`);
  }
  async list(ext: string) {
    return [...this.containers.values()]
      .filter((c) => c.ext === ext)
      .map((c) => {
        const n = this.polls.get(c.service) ?? 0;
        this.polls.set(c.service, n + 1);
        return c.running && n < this.startingPolls ? { ...c, state: 'starting' as const } : c;
      });
  }
  async run(ext: string, svc: ServiceSpec, env: Record<string, string>, fingerprint: string) {
    if (this.failRun === svc.name) throw new Error(`boom ${svc.name}`);
    this.calls.push(`run ${svc.name}`);
    this.polls.set(svc.name, 0);
    this.containers.set(`${ext}/${svc.name}`, { ext, service: svc.name, fingerprint, running: true, state: 'running', detail: 'Up', image: svc.image, env });
  }
  async start(ext: string, service: string) {
    this.calls.push(`start ${service}`);
    const c = this.containers.get(`${ext}/${service}`)!;
    Object.assign(c, { running: true, state: 'running' });
  }
  async remove(ext: string, service: string) {
    this.calls.push(`rm ${service}`);
    this.containers.delete(`${ext}/${service}`);
  }
  async logs() {
    return 'log line\n';
  }
}

const manifest: ExtensionManifestInput = {
  id: 'demo',
  name: 'Demo',
  description: 'test extension',
  version: '1.0.0',
  secrets: [{ name: 'db_password' }, { name: 'api_token' }],
  services: [
    { name: 'server', image: 'cw/server:local', local: true, port: 7700, dependsOn: ['db'], env: { DB: 'postgres://u:{{secret:db_password}}@db:5432/x', TOKEN: '{{secret:api_token}}' } },
    { name: 'db', image: 'postgres:17', port: 5432, env: { POSTGRES_PASSWORD: '{{secret:db_password}}' }, volumes: [{ name: 'db-data', target: '/var/lib/postgresql/data' }] },
  ],
  upstreams: [{ name: 'onto', description: 'Ontology', service: 'server', tokenSecret: 'api_token' }],
  bootstrap: [
    { id: 'migrate', description: 'Migrate' },
    { id: 'seed', description: 'Seed', demoOnly: true },
  ],
  uiRoutes: [{ label: 'Overview', path: '/demo' }],
};

let dir: string;
let rt: FakeRuntime;
let upstreams: UpstreamServer[];
let audit: Array<{ action: string; target: string }>;
let secretStore: Map<string, string>;
let boot: string[];

const make = (opts: { secretStore?: boolean } = {}) => {
  const svc = new ExtensionService(
    dir,
    rt,
    {
      gateway: {
        get upstreams() {
          return upstreams;
        },
        setUpstream: async (u) => void (upstreams = [...upstreams.filter((x) => x.name !== u.name), u]),
        deleteUpstream: async (n) => void (upstreams = upstreams.filter((x) => x.name !== n)),
      },
      secretStore: opts.secretStore === false ? undefined : { set: async (n: string, v: string) => void secretStore.set(n, v), remove: async (n: string) => void secretStore.delete(n) },
      audit: { write: async (e) => void audit.push(e) },
    },
    { healthTimeoutMs: 200, pollMs: 1, availabilityCacheMs: 0 },
  );
  svc.register(
    manifest,
    {
      migrate: async (ctx) => void boot.push(`migrate ${ctx.url('db')} ${ctx.secret('db_password').length > 10}`),
      seed: async () => void boot.push('seed'),
    },
  );
  return svc;
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ext-'));
  rt = new FakeRuntime();
  upstreams = [];
  audit = [];
  secretStore = new Map();
  boot = [];
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('install', () => {
  it('runs every step in order and ends installed and available', async () => {
    const svc = make();
    await svc.load();
    expect(await svc.isAvailable('demo')).toBe(false);
    await svc.install('demo', { seedDemo: true }, 'admin@x');
    await svc.idle('demo');
    const s = await svc.status('demo');
    expect(s.phase).toBe('installed');
    expect(s.available).toBe(true);
    expect(s.uiRoutes).toEqual([{ label: 'Overview', path: '/demo' }]);
    expect(s.operation?.steps.every((x) => x.state === 'done')).toBe(true);
    expect(rt.calls.filter((c) => c.startsWith('run'))).toEqual(['run db', 'run server']);
    expect(boot).toEqual(['migrate http://db:5432 true', 'seed']);
    expect(rt.volumes.has('demo/db-data')).toBe(true);
    // the upstream points to the service and its credential is a Key Vault reference, not the token itself
    expect(upstreams).toEqual([expect.objectContaining({ name: 'onto', url: 'http://server:7700/mcp', headers: { Authorization: { secretRef: 'ext-demo-api-token' } } })]);
    expect(secretStore.get('ext-demo-api-token')).toMatch(/^Bearer .{20,}/);
    expect(audit.map((a) => a.action)).toEqual(['extension.install', 'extension.install.done']);
  });

  it('skips demo-only bootstrap steps without seedDemo', async () => {
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    expect(boot).toEqual(['migrate http://db:5432 true']);
  });

  it('keeps secrets out of the state file and writes them with mode 0600', async () => {
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    const secrets = JSON.parse(await readFile(path.join(dir, 'admin', 'extensions-secrets.json'), 'utf8')) as Record<string, Record<string, string>>;
    const state = await readFile(path.join(dir, 'admin', 'extensions.json'), 'utf8');
    expect(state).not.toContain(secrets.demo!.db_password);
    expect(rt.containers.get('demo/db')!.env.POSTGRES_PASSWORD).toBe(secrets.demo!.db_password);
  });

  it('without Key Vault the upstream gets the bearer value directly', async () => {
    const svc = make({ secretStore: false });
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    expect(upstreams[0]!.headers.Authorization).toMatch(/^Bearer /);
  });

  it('fails with a build hint when a local image is missing', async () => {
    rt.images.delete('cw/server:local');
    const svc = make();
    await svc.load();
    expect((await svc.status('demo')).blockedReason).toContain('stack.mjs build --demo');
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    const s = await svc.status('demo');
    expect(s.phase).toBe('failed');
    expect(s.operation?.steps[0]).toMatchObject({ id: 'preflight', state: 'failed' });
    expect(s.operation?.steps[0]!.error).toContain('build --demo');
    expect(rt.calls.some((c) => c.startsWith('run'))).toBe(false);
  });

  it('pulls third-party images that are not present', async () => {
    rt.images.delete('postgres:17');
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    expect(rt.calls).toContain('pull postgres:17');
  });

  it('refuses to take over an upstream name that someone else registered', async () => {
    upstreams = [{ name: 'onto', url: 'http://elsewhere/mcp', headers: {}, enabled: true, auth: 'static', oboFallback: 'deny' }];
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    const s = await svc.status('demo');
    expect(s.phase).toBe('failed');
    expect(s.operation?.steps[0]!.error).toContain('not owned');
    expect(upstreams[0]!.url).toBe('http://elsewhere/mcp');
  });

  it('waits until a service is healthy, and times out with the last state', async () => {
    rt.startingPolls = 3;
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    expect((await svc.status('demo')).phase).toBe('installed');

    rt.startingPolls = 1_000_000;
    const svc2 = make();
    rt.containers.clear();
    upstreams = [];
    await rm(path.join(dir, 'admin'), { recursive: true, force: true });
    await svc2.load();
    await svc2.install('demo', { seedDemo: false }, 'a');
    await svc2.idle('demo');
    const s = await svc2.status('demo');
    expect(s.phase).toBe('failed');
    expect(s.operation?.steps.find((x) => x.state === 'failed')?.error).toMatch(/did not become healthy/);
  });

  it('rejects a second operation while one is running, and install when installed', async () => {
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await expect(svc.install('demo', { seedDemo: false }, 'a')).rejects.toThrow(/already running/);
    await svc.idle('demo');
    await expect(svc.install('demo', { seedDemo: false }, 'a')).rejects.toThrow(/installed/);
  });
});

describe('resume and repair', () => {
  it('a failed install resumes at the failed step and keeps finished work', async () => {
    rt.failRun = 'server';
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    expect((await svc.status('demo')).phase).toBe('failed');
    const dbSecret = JSON.parse(await readFile(path.join(dir, 'admin', 'extensions-secrets.json'), 'utf8')).demo.db_password;

    rt.failRun = undefined;
    rt.calls = [];
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    expect((await svc.status('demo')).phase).toBe('installed');
    // db was already running with the same fingerprint: kept, not re-created; secrets unchanged
    expect(rt.calls.filter((c) => c.startsWith('run'))).toEqual(['run server']);
    expect(JSON.parse(await readFile(path.join(dir, 'admin', 'extensions-secrets.json'), 'utf8')).demo.db_password).toBe(dbSecret);
  });

  it('an install interrupted by a restart continues when the control plane starts again', async () => {
    const first = make();
    await first.load();
    await first.install('demo', { seedDemo: false }, 'a');
    await first.idle('demo');
    // simulate a crash in the middle: state says installing, step "service:server" was running
    const file = path.join(dir, 'admin', 'extensions.json');
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.demo.phase = 'installing';
    delete state.demo.operation.finishedAt;
    for (const s of state.demo.operation.steps.slice(4)) s.state = 'pending';
    state.demo.operation.steps[4].state = 'running';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(state));
    rt.containers.delete('demo/server');

    const second = make();
    await second.load();
    await second.idle('demo');
    expect((await second.status('demo')).phase).toBe('installed');
    expect(rt.containers.has('demo/server')).toBe(true);
  });

  it('repair re-creates a container whose local image was rebuilt', async () => {
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    rt.imageIds.set('cw/server:local', 'sha256:rebuilt');
    rt.calls = [];
    await svc.repair('demo', 'a');
    await svc.idle('demo');
    expect(rt.calls).toEqual(['run server']);
  });

  it('repair re-creates a missing container and starts a stopped one', async () => {
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    rt.containers.delete('demo/server');
    Object.assign(rt.containers.get('demo/db')!, { running: false, state: 'stopped', detail: 'Exited (0)' });
    expect(await svc.isAvailable('demo')).toBe(false);
    rt.calls = [];
    await svc.repair('demo', 'a');
    await svc.idle('demo');
    expect(rt.calls).toEqual(['start db', 'run server']);
    expect(await svc.isAvailable('demo')).toBe(true);
  });
});

describe('uninstall', () => {
  it('removes owned upstreams, containers and leftovers; keeps data unless purged', async () => {
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    upstreams.push({ name: 'erp', url: 'http://other/mcp', headers: {}, enabled: true, auth: 'static', oboFallback: 'deny' });
    // a leftover container of this extension (e.g. from an older manifest) and one of another extension
    rt.containers.set('demo/old', { ext: 'demo', service: 'old', running: true, state: 'running', detail: 'Up', image: 'x', env: {} });
    rt.containers.set('other/db', { ext: 'other', service: 'db', running: true, state: 'running', detail: 'Up', image: 'x', env: {} });

    await svc.uninstall('demo', { purgeData: false }, 'a');
    await svc.idle('demo');
    const s = await svc.status('demo');
    expect(s.phase).toBe('not_installed');
    expect(s.available).toBe(false);
    expect(upstreams.map((u) => u.name)).toEqual(['erp']);
    expect([...rt.containers.keys()]).toEqual(['other/db']);
    expect(rt.volumes.has('demo/db-data')).toBe(true);
    expect(secretStore.has('ext-demo-api-token')).toBe(true);
  });

  it('purge deletes volumes and secrets; a reinstall generates new secrets', async () => {
    const svc = make();
    await svc.load();
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    const before = JSON.parse(await readFile(path.join(dir, 'admin', 'extensions-secrets.json'), 'utf8')).demo.db_password;
    await svc.uninstall('demo', { purgeData: true }, 'a');
    await svc.idle('demo');
    expect(rt.volumes.size).toBe(0);
    expect(secretStore.size).toBe(0);
    await svc.install('demo', { seedDemo: false }, 'a');
    await svc.idle('demo');
    expect(JSON.parse(await readFile(path.join(dir, 'admin', 'extensions-secrets.json'), 'utf8')).demo.db_password).not.toBe(before);
  });
});

describe('runtime helpers', () => {
  it.each([
    ['Up 3 minutes (healthy)', true, 'running'],
    ['Up 5 seconds (health: starting)', true, 'starting'],
    ['Up 2 minutes (unhealthy)', true, 'unhealthy'],
    ['Up 2 minutes', true, 'running'],
    ['Exited (1) 3 seconds ago', false, 'stopped'],
  ])('parses "%s"', (status, running, state) => expect(parseState(status, running)).toBe(state));
});

describe('liquid manifest', () => {
  it('is valid', () => {
    expect(() => extensionManifest.parse(liquidManifest)).not.toThrow();
  });

  it('three services and twelve secrets since ADR-0053 (compiler in the control plane, Forgejo on SQLite)', () => {
    const m = extensionManifest.parse(liquidManifest);
    expect(m.services.map((s) => s.name)).toEqual(['ontology-db', 'ontology-server', 'forgejo']);
    expect(m.secrets).toHaveLength(12);
    expect(m.bootstrap.map((b) => b.id)).not.toContain('forgejo-db');
  });
});
