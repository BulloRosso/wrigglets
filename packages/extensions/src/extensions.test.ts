import { describe, expect, it } from 'vitest';
import { dependencyOrder, extensionManifest, maskEnv, renderEnv, templateRefs, type ExtensionManifestInput } from './manifest.js';
import { installSteps, planDiff, serviceFingerprint, uninstallSteps } from './plan.js';

const base: ExtensionManifestInput = {
  id: 'liquid',
  name: 'Liquid',
  description: 'test',
  version: '0.1.0',
  secrets: [{ name: 'db_password' }, { name: 'onto_token' }],
  services: [
    { name: 'server', image: 'cw/onto:local', local: true, port: 7700, dependsOn: ['db'], env: { DATABASE_URL: 'postgres://onto:{{secret:db_password}}@{{svc:db.host}}:{{svc:db.port}}/onto', SELF: '{{svc:server.url}}' } },
    { name: 'db', image: 'postgres:17.6-alpine', port: 5432, env: { POSTGRES_PASSWORD: '{{secret:db_password}}' } },
  ],
  upstreams: [{ name: 'onto', description: 'Ontology', service: 'server', tokenSecret: 'onto_token' }],
  bootstrap: [
    { id: 'migrate', description: 'Migrate the database' },
    { id: 'seed', description: 'Seed demo data', demoOnly: true },
  ],
};

describe('manifest validation', () => {
  it('accepts a valid manifest and fills defaults', () => {
    const m = extensionManifest.parse(base);
    expect(m.services[1]!.volumes).toEqual([]);
    expect(m.upstreams[0]!.path).toBe('/mcp');
  });

  it.each([
    ['unknown dependency', { services: [{ name: 'a', image: 'x', dependsOn: ['nope'] }] }, 'unknown service "nope"'],
    ['unknown secret', { services: [{ name: 'a', image: 'x', env: { A: '{{secret:missing}}' } }] }, 'unknown secret "missing"'],
    ['service ref without port', { services: [{ name: 'a', image: 'x' }, { name: 'b', image: 'x', env: { U: '{{svc:a.url}}' } }] }, 'has no port'],
    ['duplicate service', { services: [{ name: 'a', image: 'x' }, { name: 'a', image: 'y' }] }, 'duplicate service'],
    ['cycle', { services: [{ name: 'a', image: 'x', dependsOn: ['b'] }, { name: 'b', image: 'x', dependsOn: ['a'] }] }, 'dependency cycle'],
    ['upstream to unknown service', { services: [], upstreams: [{ name: 'u1', description: 'd', service: 'zz' }] }, 'unknown service "zz"'],
  ])('rejects %s', (_name, patch, message) => {
    const r = extensionManifest.safeParse({ ...base, upstreams: [], secrets: [], ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join(' | ')).toContain(message);
  });
});

describe('dependency order', () => {
  it('puts dependencies first and keeps the declared order otherwise', () => {
    const order = dependencyOrder([
      { name: 'app', dependsOn: ['db', 'cache'] },
      { name: 'cache', dependsOn: [] },
      { name: 'db', dependsOn: [] },
      { name: 'worker', dependsOn: ['app'] },
    ]).map((s) => s.name);
    expect(order).toEqual(['db', 'cache', 'app', 'worker']);
  });
});

describe('environment rendering', () => {
  const m = extensionManifest.parse(base);
  const ctx = { secrets: { db_password: 's3cret', onto_token: 't' }, host: (s: string) => s, port: (s: string) => m.services.find((x) => x.name === s)?.port };

  it('fills secrets and service references', () => {
    const env = renderEnv(m.services[0]!.env, ctx);
    expect(env.DATABASE_URL).toBe('postgres://onto:s3cret@db:5432/onto');
    expect(env.SELF).toBe('http://server:7700');
  });

  it('throws on a missing secret value instead of starting with an empty one', () => {
    expect(() => renderEnv({ A: '{{secret:db_password}}' }, { ...ctx, secrets: {} })).toThrow(/not available/);
  });

  it('masks every variable that contains a secret', () => {
    const env = renderEnv(m.services[0]!.env, ctx);
    const masked = maskEnv(env, m.services[0]!.env);
    expect(masked.DATABASE_URL).toBe('••••');
    expect(masked.SELF).toBe('http://server:7700');
    expect(JSON.stringify(masked)).not.toContain('s3cret');
  });

  it('parses template references', () => {
    expect(templateRefs('{{secret:a}} {{svc:db.host}} {{svc:x}}')).toEqual([
      { kind: 'secret', name: 'a' },
      { kind: 'svc', name: 'db', field: 'host' },
      { kind: 'svc', name: 'x', field: 'url' },
    ]);
  });
});

describe('install plan', () => {
  const m = extensionManifest.parse(base);

  it('orders steps: preflight, secrets, volumes, services by dependency, bootstrap, upstreams', () => {
    expect(installSteps(m, { seedDemo: false }).map((s) => s.id)).toEqual(['preflight', 'secrets', 'volumes', 'service:db', 'service:server', 'bootstrap:migrate', 'upstreams']);
    expect(installSteps(m, { seedDemo: true }).map((s) => s.id)).toContain('bootstrap:seed');
  });

  it('uninstalls upstreams first, services in reverse order, data only on purge', () => {
    expect(uninstallSteps(m, { purgeData: false }).map((s) => s.id)).toEqual(['upstreams', 'service:server', 'service:db', 'orphans']);
    expect(uninstallSteps(m, { purgeData: true }).map((s) => s.id)).toEqual(['upstreams', 'service:server', 'service:db', 'orphans', 'volumes', 'secrets']);
  });

  it('fingerprint changes with image or environment, not with key order', () => {
    const s = m.services[1]!;
    const f = serviceFingerprint(s, { A: '1', B: '2' });
    expect(serviceFingerprint(s, { B: '2', A: '1' })).toBe(f);
    expect(serviceFingerprint(s, { A: '1', B: '3' })).not.toBe(f);
    expect(serviceFingerprint({ ...s, image: 'postgres:18' }, { A: '1', B: '2' })).not.toBe(f);
  });

  it('diffs desired and actual containers', () => {
    const d = planDiff(
      [
        { service: 'a', fingerprint: '1' },
        { service: 'b', fingerprint: '2' },
        { service: 'c', fingerprint: '3' },
        { service: 'd', fingerprint: '4' },
      ],
      [
        { service: 'b', fingerprint: 'old', running: true },
        { service: 'c', fingerprint: '3', running: false },
        { service: 'd', fingerprint: '4', running: true },
        { service: 'zombie', fingerprint: '9', running: true },
      ],
    );
    expect(d).toEqual({ create: ['a'], recreate: ['b'], start: ['c'], ok: ['d'], remove: ['zombie'] });
  });
});
