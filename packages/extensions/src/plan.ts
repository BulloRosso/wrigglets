import { dependencyOrder, type ExtensionManifest, type ServiceSpec } from './manifest.js';

/* Naming and labels of extension resources. The labels are how reset/uninstall find them; never reuse them elsewhere. */
export const LABEL_ROLE = 'cw.role';
export const LABEL_EXTENSION = 'cw.extension';
export const LABEL_SERVICE = 'cw.service';
export const LABEL_SPEC = 'cw.spec';
export const ROLE_CONTAINER = 'extension';
export const ROLE_VOLUME = 'extension-data';

export const containerName = (ext: string, svc: string) => `cw-ext-${ext}-${svc}`;
export const volumeName = (ext: string, vol: string) => `cw-ext-${ext}-${vol}`;

/** Ordered install steps. Every step is idempotent, so an interrupted install resumes at the first unfinished step. */
export function installSteps(m: ExtensionManifest, opts: { seedDemo: boolean }): Array<{ id: string; label: string }> {
  return [
    { id: 'preflight', label: 'Check images and Docker' },
    { id: 'secrets', label: 'Generate secrets' },
    { id: 'volumes', label: 'Create data volumes' },
    ...dependencyOrder(m.services).map((s) => ({ id: `service:${s.name}`, label: `Start ${s.name}` })),
    { id: 'retired', label: 'Remove containers of services this version no longer has' },
    ...m.bootstrap.filter((b) => !b.demoOnly || opts.seedDemo).map((b) => ({ id: `bootstrap:${b.id}`, label: b.description })),
    ...(m.upstreams.length ? [{ id: 'upstreams', label: `Register gateway upstreams (${m.upstreams.map((u) => u.name).join(', ')})` }] : []),
  ];
}

/** Steps of an uninstall, in order (services in reverse dependency order). */
export function uninstallSteps(m: ExtensionManifest, opts: { purgeData: boolean }): Array<{ id: string; label: string }> {
  return [
    ...(m.upstreams.length ? [{ id: 'upstreams', label: 'Remove gateway upstreams' }] : []),
    ...dependencyOrder(m.services)
      .reverse()
      .map((s) => ({ id: `service:${s.name}`, label: `Remove ${s.name}` })),
    { id: 'orphans', label: 'Remove leftover containers of this extension' },
    ...(opts.purgeData ? [{ id: 'volumes', label: 'Delete data volumes' }, { id: 'secrets', label: 'Delete secrets' }] : []),
  ];
}

/**
 * Fingerprint of what a container was created from. When it changes (new image, env template, command …) the
 * container is re-created; otherwise an existing container is kept, which makes the service step idempotent.
 */
export function serviceFingerprint(s: ServiceSpec, renderedEnv: Record<string, string>): string {
  const canonical = JSON.stringify({ i: s.image, c: s.command ?? null, e: Object.entries(renderedEnv).sort(), v: s.volumes, u: s.user ?? null, m: s.memoryMb ?? null, h: s.healthcheck ?? null });
  // FNV-1a 32 bit: stable and dependency-free; a label, not a security boundary.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface ActualContainer {
  service: string;
  fingerprint?: string;
  running: boolean;
}

/** What has to change so that the containers match the manifest. */
export function planDiff(desired: Array<{ service: string; fingerprint: string }>, actual: ActualContainer[]) {
  const create: string[] = [];
  const recreate: string[] = [];
  const start: string[] = [];
  const ok: string[] = [];
  for (const d of desired) {
    const a = actual.find((x) => x.service === d.service);
    if (!a) create.push(d.service);
    else if (a.fingerprint !== d.fingerprint) recreate.push(d.service);
    else if (!a.running) start.push(d.service);
    else ok.push(d.service);
  }
  const remove = actual.filter((a) => !desired.some((d) => d.service === a.service)).map((a) => a.service);
  return { create, recreate, start, remove, ok };
}
