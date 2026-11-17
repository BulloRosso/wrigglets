import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkApp, type AppCheck } from './appCheck.js';

/*
 * App registry of Liquid Enterprise (ADR-0050): many small UIs, each registered with an owner, the actions and classes
 * it may use, and an expiry date (default 180 days). Registration stores the submitted files and runs the static
 * check (appCheck.ts). Activation re-checks against the ontology in force and creates the app's OIDC client in the
 * local OAuth server; the app host then serves it on its own origin. Expiry (or Disable) removes the client, so the
 * app cannot sign anyone in any more. Every state change is an event (object type App) and audited.
 */

export const APP_DEFAULT_DAYS = 180;
export const APP_MAX_DAYS = 365;
const DAY = 86_400_000;

export const registerBody = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/, 'id: 3–40 characters, lowercase letters, digits and dashes'),
  name: z.string().min(3).max(80),
  description: z.string().max(1000).default(''),
  owner: z.string().email(),
  actions: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(50).default([]),
  reads: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]{1,63}$/)).max(50).default([]),
  source: z.string().url().max(500).optional(),
  expiresInDays: z.number().int().min(1).max(APP_MAX_DAYS).default(APP_DEFAULT_DAYS),
  /** path → base64 content (source, package.json, the SDK, the built dist/) */
  files: z.record(z.string(), z.string()),
});
export type RegisterInput = z.infer<typeof registerBody>;

export type AppStatus = 'registered' | 'rejected' | 'active' | 'disabled' | 'expired';

export interface AppRecord {
  id: string;
  name: string;
  description: string;
  owner: string;
  actions: string[];
  reads: string[];
  source?: string;
  version: number;
  status: AppStatus;
  registeredBy: string;
  registeredAt: string;
  expiresAt: string;
  checks: AppCheck[];
  checkedAt: string;
  ontologyVersion: string;
  clientId?: string;
  activatedBy?: string;
  activatedAt?: string;
  statusNote?: string;
  files: number;
  bytes: number;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AppRegistryDeps {
  dataDir: string;
  appsPublicUrl: string;
  oauth: { upsertClient(c: { clientId: string; name: string; kind: 'agent'; agentId: string; clientSecret: string; redirectUris: string[]; postLogoutRedirectUris: string[] }): Promise<unknown>; deleteClient(clientId: string, removeAssignments: boolean): Promise<void> };
  /** The ontology in force and its app SDK (enterprise core). */
  ontology(): Promise<{ version: string; actions: string[]; classes: string[]; sdk: string }>;
  events(events: Array<{ type: string; objectType: string; objectId: string; actorUser?: string; payload: Record<string, unknown> }>): Promise<void>;
  audit?: { write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void> };
  log?: { warn(o: object, msg: string): void };
  now?: () => number;
}

export class AppRegistry {
  private apps: AppRecord[] = [];
  private secrets: Record<string, string> = {};
  private readonly dir: string;
  private readonly file: string;
  private readonly secretsFile: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: AppRegistryDeps) {
    this.dir = path.join(d.dataDir, 'liquid', 'apps');
    this.file = path.join(d.dataDir, 'liquid', 'apps.json');
    this.secretsFile = path.join(d.dataDir, 'liquid', 'apps-secrets.json');
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async load() {
    this.apps = JSON.parse(await readFile(this.file, 'utf8').catch(() => '[]')) as AppRecord[];
    this.secrets = JSON.parse(await readFile(this.secretsFile, 'utf8').catch(() => '{}')) as Record<string, string>;
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.apps, null, 2));
    await rename(`${this.file}.tmp`, this.file);
    await writeFile(`${this.secretsFile}.tmp`, JSON.stringify(this.secrets), { mode: 0o600 });
    await rename(`${this.secretsFile}.tmp`, this.secretsFile);
    await chmod(this.secretsFile, 0o600).catch(() => undefined);
  }

  list(): AppRecord[] {
    return this.apps.map((a) => ({ ...a })).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): AppRecord | undefined {
    const a = this.apps.find((x) => x.id === id);
    return a ? { ...a } : undefined;
  }

  url(id: string) {
    return `${this.d.appsPublicUrl}/apps/${id}/`;
  }

  /** Directory of the built files the app host serves (dist/ of the current version). */
  distDir(a: Pick<AppRecord, 'id' | 'version'>) {
    return path.join(this.dir, a.id, `v${a.version}`, 'dist');
  }

  /** The OIDC client of an active app (app host). */
  client(id: string): { clientId: string; clientSecret: string } | undefined {
    const a = this.apps.find((x) => x.id === id);
    const secret = this.secrets[id];
    return a?.status === 'active' && a.clientId && secret ? { clientId: a.clientId, clientSecret: secret } : undefined;
  }

  async files(id: string): Promise<string[]> {
    const a = this.get(id);
    if (!a) throw new AppError(404, `no app ${id}`);
    const root = path.join(this.dir, id, `v${a.version}`);
    const out: string[] = [];
    const walk = async (rel: string) => {
      for (const e of await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(p);
        else out.push(p);
      }
    };
    await walk('');
    return out.sort();
  }

  /** Register (or re-register: a new version) an app; runs the check. Never activates by itself. */
  async register(input: RegisterInput, by: string): Promise<AppRecord> {
    return this.serial(async () => {
      const files: Record<string, Buffer> = {};
      for (const [p, b64] of Object.entries(input.files)) files[p.replace(/\\/g, '/')] = Buffer.from(b64, 'base64');
      const onto = await this.d.ontology();
      const checks = checkApp({ files, actions: input.actions, reads: input.reads, sdk: onto.sdk, ontology: onto });
      const ok = checks.every((c) => c.ok);
      const prev = this.apps.find((x) => x.id === input.id);
      if (prev && prev.owner !== input.owner && prev.status === 'active') throw new AppError(409, `app ${input.id} is active and owned by ${prev.owner}; disable it first to change the owner`);
      const version = (prev?.version ?? 0) + 1;
      // files are written only for a layout that passed (paths are safe); a rejected registration keeps its report
      if (checks.find((c) => c.name === 'layout')?.ok) {
        const root = path.join(this.dir, input.id, `v${version}`);
        await rm(root, { recursive: true, force: true });
        for (const [p, buf] of Object.entries(files)) {
          const target = path.join(root, p);
          if (!target.startsWith(root + path.sep)) continue;
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, buf);
        }
      }
      const at = new Date(this.now()).toISOString();
      if (prev?.clientId) await this.dropClient(prev); // a new version must be activated again
      const rec: AppRecord = {
        id: input.id,
        name: input.name,
        description: input.description,
        owner: input.owner,
        actions: [...new Set(input.actions)].sort(),
        reads: [...new Set(input.reads)].sort(),
        source: input.source,
        version,
        status: ok ? 'registered' : 'rejected',
        registeredBy: by,
        registeredAt: at,
        expiresAt: new Date(this.now() + input.expiresInDays * DAY).toISOString(),
        checks,
        checkedAt: at,
        ontologyVersion: onto.version,
        files: Object.keys(files).length,
        bytes: Object.values(files).reduce((n, b) => n + b.length, 0),
      };
      this.apps = [...this.apps.filter((x) => x.id !== input.id), rec];
      await this.persist();
      await this.record(ok ? 'AppRegistered' : 'AppRejected', rec, by, { version, checks: checks.map((c) => ({ name: c.name, ok: c.ok })) });
      return { ...rec };
    });
  }

  /** Activation: re-checked against the ontology in force, then the app gets its OIDC client (sign-in possible). */
  async activate(id: string, by: string): Promise<AppRecord> {
    return this.serial(async () => {
      const a = this.must(id);
      if (Date.parse(a.expiresAt) <= this.now()) throw new AppError(409, `app ${id} expired on ${a.expiresAt}; extend it first`);
      const recheck = await this.recheckUnlocked(a);
      if (!recheck.every((c) => c.ok)) {
        await this.persist();
        throw new AppError(409, `app ${id} does not pass the check: ${recheck.filter((c) => !c.ok).map((c) => `${c.name}: ${c.errors?.[0] ?? ''}`).join('; ')}`);
      }
      const clientId = `app-${id}`;
      const clientSecret = randomBytes(24).toString('base64url');
      await this.d.oauth.upsertClient({ clientId, name: `App: ${a.name}`, kind: 'agent', agentId: clientId, clientSecret, redirectUris: [`${this.d.appsPublicUrl}/apps/${id}/auth/callback`], postLogoutRedirectUris: [`${this.d.appsPublicUrl}/apps/${id}/`] });
      this.secrets[id] = clientSecret;
      Object.assign(a, { status: 'active' as const, clientId, activatedBy: by, activatedAt: new Date(this.now()).toISOString(), statusNote: undefined });
      await this.persist();
      await this.record('AppActivated', a, by, { version: a.version, expiresAt: a.expiresAt, url: this.url(id) });
      return { ...a };
    });
  }

  async disable(id: string, by: string, note?: string): Promise<AppRecord> {
    return this.serial(async () => {
      const a = this.must(id);
      await this.dropClient(a);
      Object.assign(a, { status: 'disabled' as const, statusNote: note ?? `disabled by ${by}` });
      await this.persist();
      await this.record('AppDisabled', a, by, { note: note ?? null });
      return { ...a };
    });
  }

  /** Extends the expiry (from now); an expired app goes back to registered and must be activated again. */
  async extend(id: string, days: number, by: string): Promise<AppRecord> {
    if (!Number.isInteger(days) || days < 1 || days > APP_MAX_DAYS) throw new AppError(400, `days must be 1–${APP_MAX_DAYS}`);
    return this.serial(async () => {
      const a = this.must(id);
      a.expiresAt = new Date(this.now() + days * DAY).toISOString();
      if (a.status === 'expired') Object.assign(a, { status: 'registered' as const, statusNote: undefined });
      await this.persist();
      await this.record('AppExtended', a, by, { expiresAt: a.expiresAt });
      return { ...a };
    });
  }

  async recheck(id: string, by: string): Promise<AppRecord> {
    return this.serial(async () => {
      const a = this.must(id);
      const checks = await this.recheckUnlocked(a);
      if (!checks.every((c) => c.ok) && a.status === 'active') {
        await this.dropClient(a);
        Object.assign(a, { status: 'rejected' as const, statusNote: 'failed a re-check (e.g. the ontology changed): register a new version' });
      } else if (checks.every((c) => c.ok) && a.status === 'rejected') a.status = 'registered';
      await this.persist();
      await this.record('AppChecked', a, by, { checks: checks.map((c) => ({ name: c.name, ok: c.ok })) });
      return { ...a };
    });
  }

  /** Expiry job: expired apps lose their OIDC client. Returns the ids that expired now. */
  async tick(): Promise<string[]> {
    return this.serial(async () => {
      const due = this.apps.filter((a) => (a.status === 'active' || a.status === 'registered') && Date.parse(a.expiresAt) <= this.now());
      for (const a of due) {
        await this.dropClient(a).catch((err: Error) => this.d.log?.warn({ app: a.id, err: err.message }, 'app expiry: could not remove the OIDC client'));
        Object.assign(a, { status: 'expired' as const, statusNote: `expired on ${a.expiresAt}` });
      }
      if (due.length) {
        await this.persist();
        for (const a of due) await this.record('AppExpired', a, 'app-registry', { expiresAt: a.expiresAt });
      }
      return due.map((a) => a.id);
    });
  }

  /** Uninstall with delete data: every app loses its OIDC client and its access list; the registry is emptied. */
  async purge(): Promise<number> {
    return this.serial(async () => {
      const n = this.apps.length;
      for (const a of this.apps) if (a.clientId) await this.d.oauth.deleteClient(a.clientId, true).catch(() => undefined);
      this.apps = [];
      this.secrets = {};
      await rm(this.dir, { recursive: true, force: true });
      await rm(this.file, { force: true });
      await rm(this.secretsFile, { force: true });
      return n;
    });
  }

  /** Active apps get their OIDC client back (e.g. after the OAuth server's data was reset). */
  async reconcileClients(): Promise<number> {
    let n = 0;
    for (const a of this.apps.filter((x) => x.status === 'active' && x.clientId && this.secrets[x.id])) {
      await this.d.oauth.upsertClient({ clientId: a.clientId!, name: `App: ${a.name}`, kind: 'agent', agentId: a.clientId!, clientSecret: this.secrets[a.id]!, redirectUris: [`${this.d.appsPublicUrl}/apps/${a.id}/auth/callback`], postLogoutRedirectUris: [`${this.d.appsPublicUrl}/apps/${a.id}/`] });
      n++;
    }
    return n;
  }

  private must(id: string): AppRecord {
    const a = this.apps.find((x) => x.id === id);
    if (!a) throw new AppError(404, `no app ${id}`);
    return a;
  }

  private async recheckUnlocked(a: AppRecord): Promise<AppCheck[]> {
    const root = path.join(this.dir, a.id, `v${a.version}`);
    if (!(await stat(root).catch(() => undefined))) {
      a.checks = [{ name: 'layout', ok: false, errors: ['the files of this version were not stored (it failed the layout check)'] }];
      return a.checks;
    }
    const files: Record<string, Buffer> = {};
    for (const p of await this.files(a.id)) files[p] = await readFile(path.join(root, p));
    const onto = await this.d.ontology();
    a.checks = checkApp({ files, actions: a.actions, reads: a.reads, sdk: onto.sdk, ontology: onto });
    a.checkedAt = new Date(this.now()).toISOString();
    a.ontologyVersion = onto.version;
    return a.checks;
  }

  private async dropClient(a: AppRecord) {
    // access (role Agent.User on app-<id>) stays: it belongs to the app, not to one client secret
    if (a.clientId) await this.d.oauth.deleteClient(a.clientId, false).catch((err: Error & { status?: number }) => {
      if (err.status !== 404) throw err;
    });
    delete this.secrets[a.id];
    a.clientId = undefined;
  }

  private async record(type: string, a: AppRecord, by: string, payload: Record<string, unknown>) {
    await this.d.events([{ type, objectType: 'App', objectId: a.id, actorUser: by, payload: { name: a.name, owner: a.owner, status: a.status, ...payload } }]).catch((err: Error) => this.d.log?.warn({ err: err.message }, 'app event not recorded'));
    await this.d.audit?.write({ by, action: `liquid.app.${type.replace(/^App/, '').toLowerCase()}`, target: a.id, details: { status: a.status, ...payload } }).catch(() => undefined);
  }
}
