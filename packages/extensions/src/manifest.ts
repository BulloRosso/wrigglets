import { z } from 'zod';

/*
 * Extension manifest (ADR-0039): what an optional module consists of, declared as data. The control plane installs it
 * by creating the services as containers, generating the secrets, running the bootstrap steps and registering the
 * gateway upstreams the extension owns. Everything here is pure; the runtime lives in the admin server.
 */

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const SECRET = /^[a-z][a-z0-9_-]{1,40}$/;

export const healthcheck = z.object({
  /** Docker healthcheck test, e.g. ["CMD-SHELL", "pg_isready -U onto"]. */
  test: z.array(z.string().min(1)).min(1),
  intervalSec: z.number().int().positive().default(10),
  timeoutSec: z.number().int().positive().default(5),
  retries: z.number().int().positive().default(10),
  startPeriodSec: z.number().int().nonnegative().default(10),
});

export const serviceSpec = z.object({
  name: z.string().regex(NAME),
  description: z.string().max(300).optional(),
  /** Image reference. Third-party images are pinned (tag@sha256 digest where available). */
  image: z.string().min(1),
  /** true = built locally by `node scripts/stack.mjs build --liquid`, never pulled. */
  local: z.boolean().default(false),
  command: z.array(z.string()).optional(),
  /** Environment; values may use {{secret:NAME}}, {{svc:NAME.url}}, {{svc:NAME.host}}, {{svc:NAME.port}}. */
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
  /** Port the service listens on inside the network (for {{svc:…}} and health). */
  port: z.number().int().min(1).max(65535).optional(),
  volumes: z.array(z.object({ name: z.string().regex(NAME), target: z.string().startsWith('/') })).default([]),
  healthcheck: healthcheck.optional(),
  dependsOn: z.array(z.string().regex(NAME)).default([]),
  /** uid[:gid] or user name; omitted = the image's default user (which must not be root for our own images). */
  user: z.string().optional(),
  memoryMb: z.number().int().min(32).max(16_384).optional(),
});

export const extensionUpstream = z.object({
  /** Gateway upstream name, e.g. "onto". */
  name: z.string().regex(NAME),
  description: z.string().max(300),
  /** Extension service that serves it … */
  service: z.string().regex(NAME).optional(),
  /** … or an absolute URL (e.g. served by the control plane: http://temporal:8080/internal/…); path is ignored then. */
  url: z.string().url().optional(),
  path: z.string().startsWith('/').default('/mcp'),
  /** Secret sent as "Authorization: Bearer <secret>" to the upstream. */
  tokenSecret: z.string().regex(SECRET).optional(),
  /** Gateway policy mode of the upstream (ADR-0044). */
  policy: z.enum(['none', 'opa']).default('none'),
});

export const extensionManifest = z
  .object({
    id: z.string().regex(NAME),
    name: z.string().min(1).max(80),
    description: z.string().max(1000),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Link to the user documentation (relative to the repository). */
    docs: z.string().optional(),
    services: z.array(serviceSpec).default([]),
    secrets: z.array(z.object({ name: z.string().regex(SECRET), bytes: z.number().int().min(16).max(64).default(24) })).default([]),
    /** Secrets also stored in Key Vault as ext-<id>-<name> (raw value) for platform services, e.g. the gateway. */
    vaultSecrets: z.array(z.string().regex(SECRET)).default([]),
    upstreams: z.array(extensionUpstream).default([]),
    /** Named bootstrap steps, run in order after all services are healthy; implemented by the control plane. */
    bootstrap: z.array(z.object({ id: z.string().regex(NAME), description: z.string().max(300), demoOnly: z.boolean().default(false) })).default([]),
    /** Admin console pages the extension adds while installed. */
    uiRoutes: z.array(z.object({ label: z.string().max(40), path: z.string().startsWith('/') })).default([]),
  })
  .superRefine((m, ctx) => {
    const names = new Set<string>();
    for (const s of m.services) {
      if (names.has(s.name)) ctx.addIssue({ code: 'custom', message: `duplicate service "${s.name}"`, path: ['services'] });
      names.add(s.name);
    }
    const secrets = new Set(m.secrets.map((s) => s.name));
    for (const s of m.services) {
      for (const d of s.dependsOn) if (!names.has(d)) ctx.addIssue({ code: 'custom', message: `service "${s.name}" depends on unknown service "${d}"`, path: ['services'] });
      for (const [i, c] of (s.command ?? []).entries()) {
        for (const ref of templateRefs(c)) {
          if (ref.kind === 'secret' && !secrets.has(ref.name)) ctx.addIssue({ code: 'custom', message: `${s.name}.command[${i}]: unknown secret "${ref.name}"`, path: ['services'] });
          if (ref.kind === 'svc' && !names.has(ref.name)) ctx.addIssue({ code: 'custom', message: `${s.name}.command[${i}]: unknown service "${ref.name}"`, path: ['services'] });
        }
      }
      for (const [k, v] of Object.entries(s.env)) {
        for (const ref of templateRefs(v)) {
          if (ref.kind === 'secret' && !secrets.has(ref.name)) ctx.addIssue({ code: 'custom', message: `${s.name}.${k}: unknown secret "${ref.name}"`, path: ['services'] });
          if (ref.kind === 'svc' && !names.has(ref.name)) ctx.addIssue({ code: 'custom', message: `${s.name}.${k}: unknown service "${ref.name}"`, path: ['services'] });
          if (ref.kind === 'svc' && ref.field !== 'host' && m.services.find((x) => x.name === ref.name)?.port === undefined)
            ctx.addIssue({ code: 'custom', message: `${s.name}.${k}: service "${ref.name}" has no port`, path: ['services'] });
        }
      }
    }
    for (const v of m.vaultSecrets) if (!secrets.has(v)) ctx.addIssue({ code: 'custom', message: `vault secret "${v}" is not a declared secret`, path: ['vaultSecrets'] });
    for (const u of m.upstreams) {
      if (u.tokenSecret && !secrets.has(u.tokenSecret)) ctx.addIssue({ code: 'custom', message: `upstream "${u.name}": unknown secret "${u.tokenSecret}"`, path: ['upstreams'] });
      if (!u.service === !u.url) {
        ctx.addIssue({ code: 'custom', message: `upstream "${u.name}": exactly one of service or url`, path: ['upstreams'] });
        continue;
      }
      if (u.url) continue;
      const svc = m.services.find((s) => s.name === u.service);
      if (!svc) ctx.addIssue({ code: 'custom', message: `upstream "${u.name}" refers to unknown service "${u.service}"`, path: ['upstreams'] });
      else if (svc.port === undefined) ctx.addIssue({ code: 'custom', message: `upstream "${u.name}": service "${u.service}" has no port`, path: ['upstreams'] });
    }
    try {
      dependencyOrder(m.services);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message, path: ['services'] });
    }
  });

export type ServiceSpec = z.infer<typeof serviceSpec>;
export type ExtensionManifest = z.infer<typeof extensionManifest>;
export type ExtensionManifestInput = z.input<typeof extensionManifest>;
export type ExtensionUpstream = z.infer<typeof extensionUpstream>;

type Ref = { kind: 'secret'; name: string } | { kind: 'svc'; name: string; field: 'url' | 'host' | 'port' };
const TEMPLATE = /\{\{\s*(secret|svc):([a-z][a-z0-9_-]*)(?:\.(url|host|port))?\s*\}\}/g;

/** The {{…}} references in a template string. */
export function templateRefs(value: string): Ref[] {
  return [...value.matchAll(TEMPLATE)].map((m) => (m[1] === 'secret' ? { kind: 'secret', name: m[2]! } : { kind: 'svc', name: m[2]!, field: (m[3] ?? 'url') as 'url' | 'host' | 'port' }));
}

/** Services sorted so that every service comes after the services it depends on (stable; throws on a cycle). */
export function dependencyOrder<T extends Pick<ServiceSpec, 'name' | 'dependsOn'>>(services: T[]): T[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const out: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: T, chain: string[]) => {
    const st = state.get(s.name);
    if (st === 'done') return;
    if (st === 'visiting') throw new Error(`dependency cycle: ${[...chain, s.name].join(' → ')}`);
    state.set(s.name, 'visiting');
    for (const d of s.dependsOn) {
      const dep = byName.get(d);
      if (dep) visit(dep, [...chain, s.name]);
    }
    state.set(s.name, 'done');
    out.push(s);
  };
  for (const s of services) visit(s, []);
  return out;
}

export interface RenderContext {
  /** Secret values by name. */
  secrets: Record<string, string>;
  /** Network host name of a service (its container alias). */
  host: (service: string) => string;
  port: (service: string) => number | undefined;
}

/** Fills the {{…}} templates of an environment. Throws on an unknown reference, so a broken manifest never starts. */
export function renderEnv(env: Record<string, string>, ctx: RenderContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(TEMPLATE, (_m, kind: string, name: string, field?: string) => {
      if (kind === 'secret') {
        const s = ctx.secrets[name];
        if (s === undefined) throw new Error(`${k}: secret "${name}" is not available`);
        return s;
      }
      const port = ctx.port(name);
      if (field === 'host') return ctx.host(name);
      if (port === undefined) throw new Error(`${k}: service "${name}" has no port`);
      if (field === 'port') return String(port);
      return `http://${ctx.host(name)}:${port}`;
    });
  }
  return out;
}

/** Environment with secret values masked, for logs and the API (secrets never leave the control plane in clear). */
export function maskEnv(env: Record<string, string>, template: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, templateRefs(template[k] ?? '').some((r) => r.kind === 'secret') ? '••••' : v]));
}
