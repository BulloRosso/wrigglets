import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretStore } from '@cw/secrets';
import type { UpstreamServer } from '@cw/shared';
import {
  extensionManifest,
  installSteps,
  maskEnv,
  renderEnv,
  serviceFingerprint,
  uninstallSteps,
  type ExtensionManifest,
  type ExtensionManifestInput,
  type ExtensionOperation,
  type ExtensionPhase,
  type ExtensionServiceStatus,
  type ExtensionStatus,
  type ExtensionStep,
} from '@cw/extensions';
import { logger } from '../logger.js';
import type { ExtensionRuntime } from './runtime.js';

/*
 * Extension manager (ADR-0039): installs optional modules from the admin console. One operation per extension at a
 * time; every step is idempotent and persisted, so an interrupted install or uninstall resumes when the control plane
 * starts again. Secrets live in DATA_DIR/admin/extensions-secrets.json (0600, like agent secrets in agents.json); the
 * upstream credentials the gateway needs go to Key Vault when it is configured.
 */

export class ExtensionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BootstrapContext {
  extension: string;
  secret(name: string): string;
  /** http://<host>:<port> of a service as reachable from the control plane. */
  url(service: string): string;
  host(service: string): string;
  log(msg: string, data?: Record<string, unknown>): void;
  /** Runs a command in a service container of the extension (Docker runtime only). */
  exec(service: string, cmd: string[], user?: string): Promise<{ code: number; output: string }>;
}
export type BootstrapHandler = (ctx: BootstrapContext) => Promise<void>;

export interface OverlayOptions {
  /** The extension's services were started with a compose overlay (e.g. LIQUID_OVERLAY=true). */
  active: boolean;
  /** Secret values from the environment in overlay mode, by secret name. */
  secrets: Record<string, string | undefined>;
}

interface Registered {
  manifest: ExtensionManifest;
  handlers: Record<string, BootstrapHandler>;
  overlay: OverlayOptions;
}

interface ExtensionRecord {
  phase: ExtensionPhase;
  installedAt?: string;
  installedBy?: string;
  installedVersion?: string;
  options: { seedDemo: boolean };
  /** Gateway upstreams this extension registered and therefore removes again. */
  upstreams: string[];
  operation?: ExtensionOperation;
}

interface Deps {
  gateway: { upstreams: UpstreamServer[]; setUpstream(u: UpstreamServer): Promise<void>; deleteUpstream(name: string): Promise<void> };
  secretStore?: Pick<SecretStore, 'set' | 'remove'>;
  audit: { write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void> };
}

export interface Timing {
  healthTimeoutMs: number;
  pollMs: number;
  availabilityCacheMs: number;
}

const DEFAULT_TIMING: Timing = { healthTimeoutMs: 240_000, pollMs: 2_000, availabilityCacheMs: 10_000 };
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const upstreamSecretRef = (ext: string, secret: string) => `ext-${ext}-${secret.replace(/_/g, '-')}`;
/** Key Vault name of a raw extension secret (manifest vaultSecrets). */
export const vaultSecretRef = (ext: string, secret: string) => `ext-${ext}-${secret.replace(/_/g, '-')}-raw`;

export class ExtensionService {
  private readonly registered = new Map<string, Registered>();
  private state: Record<string, ExtensionRecord> = {};
  private secrets: Record<string, Record<string, string>> = {};
  private readonly running = new Map<string, Promise<void>>();
  private readonly availability = new Map<string, { at: number; value: boolean }>();
  private readonly stateFile: string;
  private readonly secretsFile: string;
  private readonly timing: Timing;

  constructor(
    dataDir: string,
    private readonly runtime: ExtensionRuntime | undefined,
    private readonly deps: Deps,
    timing: Partial<Timing> = {},
  ) {
    this.stateFile = path.join(dataDir, 'admin', 'extensions.json');
    this.secretsFile = path.join(dataDir, 'admin', 'extensions-secrets.json');
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  register(manifest: ExtensionManifestInput, handlers: Record<string, BootstrapHandler> = {}, overlay: OverlayOptions = { active: false, secrets: {} }) {
    const m = extensionManifest.parse(manifest);
    for (const b of m.bootstrap) if (!handlers[b.id]) throw new Error(`extension ${m.id}: no handler for bootstrap step "${b.id}"`);
    this.registered.set(m.id, { manifest: m, handlers, overlay });
  }

  async load() {
    this.state = JSON.parse(await readFile(this.stateFile, 'utf8').catch(() => '{}')) as Record<string, ExtensionRecord>;
    this.secrets = JSON.parse(await readFile(this.secretsFile, 'utf8').catch(() => '{}')) as Record<string, Record<string, string>>;
    // Resume operations that were interrupted by a restart.
    for (const [id, rec] of Object.entries(this.state)) {
      if (!this.registered.has(id) || !rec.operation || rec.operation.finishedAt) continue;
      if (rec.phase !== 'installing' && rec.phase !== 'uninstalling') continue;
      for (const s of rec.operation.steps) if (s.state === 'running') s.state = 'pending';
      logger.info({ extension: id, operation: rec.operation.kind }, 'resuming extension operation');
      this.launch(id);
    }
  }

  /** Waits for a running operation (tests, shutdown). */
  async idle(id: string) {
    await this.running.get(id);
  }

  private rec(id: string): ExtensionRecord {
    return (this.state[id] ??= { phase: 'not_installed', options: { seedDemo: false }, upstreams: [] });
  }

  private reg(id: string): Registered {
    const r = this.registered.get(id);
    if (!r) throw new ExtensionError(404, `unknown extension "${id}"`);
    return r;
  }

  private async persist() {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeFile(`${this.stateFile}.tmp`, JSON.stringify(this.state, null, 2));
    await rename(`${this.stateFile}.tmp`, this.stateFile);
  }

  private async persistSecrets() {
    await mkdir(path.dirname(this.secretsFile), { recursive: true });
    await writeFile(`${this.secretsFile}.tmp`, JSON.stringify(this.secrets, null, 2), { mode: 0o600 });
    await rename(`${this.secretsFile}.tmp`, this.secretsFile);
    await chmod(this.secretsFile, 0o600).catch(() => undefined);
  }

  /* ---------------------------------------------------------------------------------------------- read side */

  secret(id: string, name: string): string | undefined {
    const r = this.reg(id);
    return r.overlay.active ? r.overlay.secrets[name] : this.secrets[id]?.[name];
  }

  /** Every secret value of an extension (to keep them out of the config repository, ADR-0046). */
  secretValues(id: string): string[] {
    const r = this.registered.get(id);
    if (!r) return [];
    return Object.values(r.overlay.active ? r.overlay.secrets : (this.secrets[id] ?? {})).filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  url(id: string, service: string): string {
    const svc = this.reg(id).manifest.services.find((s) => s.name === service);
    if (!svc?.port) throw new ExtensionError(500, `extension ${id}: service "${service}" has no port`);
    return `http://${service}:${svc.port}`;
  }

  /** Installed (or overlay) — without checking health; for synchronous configuration builders. */
  isInstalled(id: string): boolean {
    const r = this.registered.get(id);
    return !!r && (r.overlay.active || this.rec(id).phase === 'installed');
  }

  /** The extension's features are on: overlay present, or installed with every service running. Cached briefly. */
  async isAvailable(id: string): Promise<boolean> {
    const r = this.registered.get(id);
    if (!r) return false;
    if (r.overlay.active) return true;
    if (this.rec(id).phase !== 'installed' || !this.runtime) return false;
    const cached = this.availability.get(id);
    if (cached && Date.now() - cached.at < this.timing.availabilityCacheMs) return cached.value;
    const actual = await this.runtime.list(id).catch(() => []);
    const value = r.manifest.services.every((s) => actual.find((a) => a.service === s.name)?.state === 'running');
    this.availability.set(id, { at: Date.now(), value });
    return value;
  }

  async list(): Promise<ExtensionStatus[]> {
    return Promise.all([...this.registered.keys()].map((id) => this.status(id)));
  }

  async status(id: string): Promise<ExtensionStatus> {
    const { manifest: m, overlay } = this.reg(id);
    const rec = this.rec(id);
    const actual = overlay.active || !this.runtime ? [] : await this.runtime.list(id).catch(() => []);
    const presence = !this.runtime || overlay.active ? [] : await Promise.all(m.services.map(async (s) => [s.name, await this.runtime!.imagePresent(s.image).catch(() => false)] as const));
    const services: ExtensionServiceStatus[] = m.services.map((s) => {
      const a = actual.find((x) => x.service === s.name);
      const imagePresent = presence.find(([n]) => n === s.name)?.[1];
      return {
        name: s.name,
        description: s.description,
        image: s.image,
        local: s.local,
        state: overlay.active ? 'running' : (a?.state ?? 'missing'),
        detail: overlay.active ? 'managed by the compose overlay' : (a?.detail ?? 'not created'),
        imagePresent,
      };
    });
    const missingImages = services.filter((s) => s.local && s.imagePresent === false).map((s) => s.image);
    let blockedReason: string | undefined;
    if (overlay.active) blockedReason = 'Started with the compose overlay; manage it with node scripts/stack.mjs liquid up|down.';
    else if (!this.runtime) blockedReason = 'Extensions need the Docker runtime (RUNTIME=docker).';
    else if (missingImages.length) blockedReason = `Build the images first: node scripts/stack.mjs build --${id}`;
    const available = await this.isAvailable(id);
    return {
      id,
      name: m.name,
      description: m.description,
      version: m.version,
      docs: m.docs,
      mode: overlay.active ? 'overlay' : 'console',
      phase: overlay.active ? 'installed' : rec.phase,
      available,
      installedAt: rec.installedAt,
      installedBy: rec.installedBy,
      installedVersion: rec.installedVersion,
      operation: rec.operation,
      services,
      upstreams: overlay.active ? m.upstreams.map((u) => u.name) : rec.upstreams,
      uiRoutes: available ? m.uiRoutes : [],
      missingImages,
      blockedReason,
    };
  }

  async logs(id: string, service: string, tail = 200) {
    const { manifest } = this.reg(id);
    if (!manifest.services.some((s) => s.name === service)) throw new ExtensionError(404, `unknown service "${service}"`);
    if (!this.runtime) throw new ExtensionError(409, 'no Docker runtime');
    return this.runtime.logs(id, service, Math.min(Math.max(tail, 1), 2000));
  }

  /* --------------------------------------------------------------------------------------------- operations */

  private guard(id: string, allowed: ExtensionPhase[]) {
    const r = this.reg(id);
    if (r.overlay.active) throw new ExtensionError(409, `extension ${id} runs from the compose overlay; it is not managed here`);
    if (!this.runtime) throw new ExtensionError(409, 'extensions need the Docker runtime (RUNTIME=docker)');
    const phase = this.rec(id).phase;
    if (this.running.has(id)) throw new ExtensionError(409, `an operation on ${id} is already running`);
    if (!allowed.includes(phase)) throw new ExtensionError(409, `cannot do this while ${id} is ${phase.replace('_', ' ')}`);
    return r;
  }

  private begin(id: string, kind: ExtensionOperation['kind'], by: string, options: Record<string, boolean>, steps: Array<{ id: string; label: string }>) {
    const rec = this.rec(id);
    rec.operation = { kind, by, startedAt: now(), options, steps: steps.map((s) => ({ ...s, state: 'pending' })) };
    rec.phase = kind === 'uninstall' ? 'uninstalling' : 'installing';
    this.availability.delete(id);
  }

  async install(id: string, opts: { seedDemo: boolean }, by: string) {
    const { manifest } = this.guard(id, ['not_installed', 'failed']);
    const rec = this.rec(id);
    rec.options = { seedDemo: opts.seedDemo };
    this.begin(id, 'install', by, opts, installSteps(manifest, opts));
    await this.persist();
    await this.deps.audit.write({ by, action: 'extension.install', target: id, details: { version: manifest.version, ...opts } });
    this.launch(id);
    return this.status(id);
  }

  /** Re-runs every install step (idempotent): re-creates changed or missing containers, re-registers upstreams. */
  async repair(id: string, by: string) {
    const { manifest } = this.guard(id, ['installed', 'failed']);
    const rec = this.rec(id);
    this.begin(id, 'repair', by, rec.options, installSteps(manifest, rec.options));
    await this.persist();
    await this.deps.audit.write({ by, action: 'extension.repair', target: id });
    this.launch(id);
    return this.status(id);
  }

  async uninstall(id: string, opts: { purgeData: boolean }, by: string) {
    const { manifest } = this.guard(id, ['installed', 'failed']);
    this.begin(id, 'uninstall', by, opts, uninstallSteps(manifest, opts));
    await this.persist();
    await this.deps.audit.write({ by, action: 'extension.uninstall', target: id, details: opts });
    this.launch(id);
    return this.status(id);
  }

  private launch(id: string) {
    const p = this.execute(id)
      .catch((err) => logger.error({ extension: id, err: String(err) }, 'extension operation crashed'))
      .finally(() => this.running.delete(id));
    this.running.set(id, p);
  }

  private async execute(id: string) {
    const rec = this.rec(id);
    const op = rec.operation!;
    for (const step of op.steps) {
      if (step.state === 'done' || step.state === 'skipped') continue;
      step.state = 'running';
      step.startedAt = now();
      step.error = undefined;
      await this.persist();
      try {
        await (op.kind === 'uninstall' ? this.uninstallStep(id, step) : this.installStep(id, step));
        step.state = 'done';
        step.finishedAt = now();
        await this.persist();
      } catch (err) {
        step.state = 'failed';
        step.finishedAt = now();
        step.error = err instanceof Error ? err.message : String(err);
        op.finishedAt = now();
        rec.phase = 'failed';
        await this.persist();
        logger.warn({ extension: id, step: step.id, err: step.error }, 'extension step failed');
        await this.deps.audit.write({ by: op.by, action: `extension.${op.kind}.failed`, target: id, details: { step: step.id, error: step.error } });
        return;
      }
    }
    op.finishedAt = now();
    if (op.kind === 'uninstall') {
      rec.phase = 'not_installed';
      rec.installedAt = rec.installedBy = rec.installedVersion = undefined;
    } else {
      rec.phase = 'installed';
      if (op.kind === 'install' || !rec.installedAt) {
        rec.installedAt = op.finishedAt;
        rec.installedBy = op.by;
      }
      rec.installedVersion = this.reg(id).manifest.version;
    }
    this.availability.delete(id);
    await this.persist();
    await this.deps.audit.write({ by: op.by, action: `extension.${op.kind}.done`, target: id });
    await this.onOperationDone?.(id, op.kind, op.by)?.catch?.((err: unknown) => logger.warn({ extension: id, err: String(err) }, 'onOperationDone failed'));
  }

  /** Called after an install/repair/uninstall finished (e.g. to record owned upstreams in the config repository). */
  onOperationDone?: (id: string, kind: ExtensionOperation['kind'], by: string) => Promise<unknown> | undefined;

  /** An install/repair/uninstall is running right now. */
  busy(id: string): boolean {
    return this.running.has(id);
  }

  private context(id: string): BootstrapContext {
    return {
      extension: id,
      secret: (name) => {
        const v = this.secret(id, name);
        if (v === undefined) throw new Error(`secret "${name}" is missing`);
        return v;
      },
      url: (service) => this.url(id, service),
      exec: async (service, cmd, user) => {
        if (!this.runtime) throw new Error('no container runtime');
        return this.runtime.exec(id, service, cmd, user);
      },
      host: (service) => service,
      log: (msg, data) => logger.info({ extension: id, ...data }, msg),
    };
  }

  private async installStep(id: string, step: ExtensionStep) {
    const { manifest: m, handlers } = this.reg(id);
    const rt = this.runtime!;
    const rec = this.rec(id);
    if (step.id === 'preflight') {
      const ping = await rt.ping();
      if (!ping.ok) throw new Error(`Docker is not reachable: ${ping.detail}`);
      for (const s of m.services) {
        if (await rt.imagePresent(s.image)) continue;
        if (s.local) throw new Error(`image ${s.image} is missing: run node scripts/stack.mjs build --${id}`);
        await rt.pullImage(s.image);
      }
      // Upstream names must not collide with upstreams someone else registered.
      for (const u of m.upstreams) {
        if (this.deps.gateway.upstreams.some((x) => x.name === u.name) && !rec.upstreams.includes(u.name)) throw new Error(`gateway upstream "${u.name}" already exists and is not owned by ${id}`);
      }
      return;
    }
    if (step.id === 'secrets') {
      const mine = (this.secrets[id] ??= {});
      let changed = false;
      for (const s of m.secrets) {
        if (!mine[s.name]) {
          mine[s.name] = randomBytes(s.bytes).toString('base64url');
          changed = true;
        }
      }
      if (changed) await this.persistSecrets();
      if (this.deps.secretStore) {
        for (const u of m.upstreams) if (u.tokenSecret) await this.deps.secretStore.set(upstreamSecretRef(id, u.tokenSecret), `Bearer ${mine[u.tokenSecret]}`, { tags: { extension: id } });
        // raw values for platform services that read them from Key Vault (e.g. the gateway's OPA query token)
        for (const v of m.vaultSecrets) await this.deps.secretStore.set(vaultSecretRef(id, v), mine[v]!, { tags: { extension: id } });
      }
      return;
    }
    if (step.id === 'volumes') {
      for (const v of new Set(m.services.flatMap((s) => s.volumes.map((x) => x.name)))) await rt.ensureVolume(id, v);
      return;
    }
    if (step.id.startsWith('service:')) {
      const svc = m.services.find((s) => s.name === step.id.slice('service:'.length));
      if (!svc) throw new Error(`unknown service in ${step.id}`);
      const rctx = { secrets: this.secrets[id] ?? {}, host: (s: string) => s, port: (s: string) => m.services.find((x) => x.name === s)?.port };
      const env = renderEnv(svc.env, rctx);
      const command = svc.command?.map((c, i) => renderEnv({ [`ARG${i}`]: c }, rctx)[`ARG${i}`]!);
      // The image id is part of the fingerprint, so a rebuilt :local image re-creates the container on repair.
      const fingerprint = serviceFingerprint({ ...svc, command, image: `${svc.image}@${(await rt.imageId(svc.image)) ?? "?"}` }, env);
      const current = (await rt.list(id)).find((a) => a.service === svc.name);
      if (!current || current.fingerprint !== fingerprint) {
        logger.info({ extension: id, service: svc.name, env: maskEnv(env, svc.env) }, current ? 'extension service changed, re-creating' : 'creating extension service');
        await rt.run(id, { ...svc, command }, env, fingerprint);
      } else if (!current.running) await rt.start(id, svc.name);
      await this.waitRunning(id, svc.name);
      return;
    }
    if (step.id === 'retired') {
      // e.g. OPA and the business worker after ADR-0049: their containers go, their volumes stay (purge on uninstall)
      if (!this.runtime) return;
      const keep = new Set(m.services.map((s) => s.name));
      for (const c of await this.runtime.list(id)) if (!keep.has(c.service)) await this.runtime.remove(id, c.service);
      return;
    }
    if (step.id.startsWith('bootstrap:')) {
      const handler = handlers[step.id.slice('bootstrap:'.length)];
      if (!handler) throw new Error(`no handler for ${step.id}`);
      await handler(this.context(id));
      return;
    }
    if (step.id === 'upstreams') {
      for (const u of m.upstreams) {
        const token = u.tokenSecret ? this.secrets[id]?.[u.tokenSecret] : undefined;
        const headers: UpstreamServer['headers'] = u.tokenSecret ? { Authorization: this.deps.secretStore ? { secretRef: upstreamSecretRef(id, u.tokenSecret) } : `Bearer ${token}` } : {};
        await this.deps.gateway.setUpstream({ name: u.name, description: u.description, url: u.url ?? `${this.url(id, u.service!)}${u.path}`, headers, enabled: true, auth: 'static', oboFallback: 'deny', policy: u.policy });
        if (!rec.upstreams.includes(u.name)) rec.upstreams.push(u.name);
      }
      return;
    }
    throw new Error(`unknown install step ${step.id}`);
  }

  private async uninstallStep(id: string, step: ExtensionStep) {
    const { manifest: m } = this.reg(id);
    const rt = this.runtime!;
    const rec = this.rec(id);
    if (step.id === 'upstreams') {
      for (const name of [...rec.upstreams]) {
        if (this.deps.gateway.upstreams.some((u) => u.name === name)) await this.deps.gateway.deleteUpstream(name);
        rec.upstreams = rec.upstreams.filter((n) => n !== name);
      }
      return;
    }
    if (step.id.startsWith('service:')) return rt.remove(id, step.id.slice('service:'.length));
    if (step.id === 'orphans') {
      for (const c of await rt.list(id)) await rt.remove(id, c.service);
      return;
    }
    if (step.id === 'volumes') {
      // declared volumes and those of services an earlier version had (labelled for this extension)
      const all = new Set([...m.services.flatMap((s) => s.volumes.map((x) => x.name)), ...((await rt.listVolumes?.(id).catch(() => [])) ?? [])]);
      for (const v of all) await rt.removeVolume(id, v);
      return;
    }
    if (step.id === 'secrets') {
      if (this.deps.secretStore) {
        for (const u of m.upstreams) if (u.tokenSecret) await this.deps.secretStore.remove(upstreamSecretRef(id, u.tokenSecret)).catch(() => undefined);
        for (const v of m.vaultSecrets) await this.deps.secretStore.remove(vaultSecretRef(id, v)).catch(() => undefined);
      }
      delete this.secrets[id];
      await this.persistSecrets();
      return;
    }
    throw new Error(`unknown uninstall step ${step.id}`);
  }

  private async waitRunning(id: string, service: string) {
    const deadline = Date.now() + this.timing.healthTimeoutMs;
    let last = 'not created';
    while (Date.now() < deadline) {
      const c = (await this.runtime!.list(id)).find((a) => a.service === service);
      if (c?.state === 'running') return;
      if (c && !c.running && c.state === 'stopped' && /Exited/.test(c.detail)) throw new Error(`${service} exited: ${c.detail}`);
      last = c?.detail ?? 'not created';
      await sleep(this.timing.pollMs);
    }
    throw new Error(`${service} did not become healthy in ${Math.round(this.timing.healthTimeoutMs / 1000)} s (${last})`);
  }
}
