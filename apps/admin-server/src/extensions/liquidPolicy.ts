import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';

/*
 * Policy as code, control-plane side (ADR-0044):
 *   - tightening overlays (data.liquid.overlays): added by admins now, by playbooks from M7 (tighten automatically),
 *     removed only by a person (loosen with approval);
 *   - the OPA bundle: the Rego policies of policies/liquid, the roles, the generated ontology data, the overlays and
 *     OPA's own query token, as a deterministic tar.gz with a content revision (OPA polls it with If-None-Match);
 *   - the last decisions OPA reports (decision logs), for the Policies page.
 */

export const overlayInput = z.object({
  effect: z.enum(['deny', 'require_four_eyes', 'require_step_up']),
  reason: z.string().trim().min(3).max(300),
  match: z
    .object({
      actions: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,80}$/)).min(1).optional(),
      classes: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]{1,80}$/)).min(1).optional(),
      upstreams: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,30}$/)).min(1).optional(),
      agents: z.array(z.string().min(1).max(40)).min(1).optional(),
    })
    .strict()
    .refine((m) => Object.keys(m).length > 0, 'an overlay must match something (actions, classes, upstreams or agents)'),
  expires_at: z.iso.datetime({ offset: true }).optional(),
  /** Where the overlay comes from, e.g. "admin" or "playbook:third-party-upstream-vulnerability/run-17". */
  source: z.string().max(200).default('admin'),
});
export type OverlayInput = z.input<typeof overlayInput>;
export interface Overlay extends z.infer<typeof overlayInput> {
  id: string;
  createdAt: string;
  createdBy: string;
}

export interface DecisionLogEntry {
  at: string;
  path: string;
  allow: boolean | null;
  reason: string | null;
  obligations: string[];
  input: { agent?: string; action?: string; tool?: string; caller?: string };
}

/* ---------------------------------------------------------------------------------------------- tar (ustar) */

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  const w = (s: string, off: number, len: number) => h.write(s, off, len, 'utf8');
  if (Buffer.byteLength(name) > 100) throw new Error(`bundle path too long: ${name}`);
  w(name, 0, 100);
  w('0000644\0', 100, 8);
  w('0000000\0', 108, 8);
  w('0000000\0', 116, 8);
  w(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  w('00000000000\0', 136, 12); // mtime 0: the bundle bytes depend only on its content
  w('        ', 148, 8);
  w('0', 156, 1);
  w('ustar\0', 257, 6);
  w('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  w(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** A gzip'd tar of the given files (sorted by path; deterministic). */
export function tarGz(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const name of Object.keys(files).sort()) {
    const data = Buffer.from(files[name]!, 'utf8');
    parts.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Reads a tar.gz back into { path: content } (tests and diagnostics). */
export function untarGz(buf: Buffer): Record<string, string> {
  const tar = gunzipSync(buf);
  const out: Record<string, string> = {};
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, ''), 8);
    out[name] = tar.subarray(off + 512, off + 512 + size).toString('utf8');
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- service */

export class LiquidPolicyService {
  private overlays: Overlay[] = [];
  private readonly file: string;
  private ontologyData: unknown;
  private lastBundle?: { revision: string; builtAt: string; files: string[] };
  private lastFetch?: { at: string; revision: string; notModified: boolean };
  private decisions: DecisionLogEntry[] = [];
  onChange?: () => void;

  constructor(
    dataDir: string,
    private readonly policyDir: string,
    private readonly fetchOntologyData: () => Promise<unknown>,
    private readonly queryToken: () => string | undefined,
  ) {
    this.file = path.join(dataDir, 'admin', 'liquid-overlays.json');
  }

  async load() {
    this.overlays = JSON.parse(await readFile(this.file, 'utf8').catch(() => '[]')) as Overlay[];
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.overlays, null, 2));
    await rename(`${this.file}.tmp`, this.file);
    this.onChange?.();
  }

  listOverlays(): Overlay[] {
    return [...this.overlays];
  }

  /** Tightening: always allowed for an authorised caller (admin now, playbooks later). */
  async addOverlay(input: OverlayInput, by: string): Promise<Overlay> {
    const o = overlayInput.parse(input);
    const n = this.overlays.reduce((m, x) => Math.max(m, Number(x.id.replace(/^ov-/, '')) || 0), 0) + 1;
    const overlay: Overlay = { ...o, id: `ov-${n}`, createdAt: new Date().toISOString(), createdBy: by };
    this.overlays.push(overlay);
    await this.persist();
    return overlay;
  }

  /** Loosening: only a person may remove an overlay (plan §1.3 invariant 6); the API route is Platform.Admin only. */
  async removeOverlay(id: string): Promise<Overlay | undefined> {
    const o = this.overlays.find((x) => x.id === id);
    if (!o) return undefined;
    this.overlays = this.overlays.filter((x) => x.id !== id);
    await this.persist();
    return o;
  }

  private async policyFiles(): Promise<{ rego: Record<string, string>; roles: unknown }> {
    const rego: Record<string, string> = {};
    const walk = async (dir: string, rel: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(p, r);
        else if (e.name.endsWith('.rego') && !e.name.endsWith('_test.rego')) rego[r] = await readFile(p, 'utf8');
      }
    };
    await walk(this.policyDir, '');
    const rolesPath = path.join(this.policyDir, 'roles', 'data.json');
    const roles = existsSync(rolesPath) ? JSON.parse(await readFile(rolesPath, 'utf8')) : { roles: {}, agents: {} };
    return { rego, roles };
  }

  /** Builds the bundle: policies under liquid/ (system/ stays at its own root), one data.json with all data. */
  async bundle(): Promise<{ revision: string; body: Buffer }> {
    try {
      this.ontologyData = (await this.fetchOntologyData()) ?? this.ontologyData;
    } catch {
      /* ontology server not reachable: keep the last known data (none = unknown actions are denied) */
    }
    const { rego, roles } = await this.policyFiles();
    const files: Record<string, string> = {};
    for (const [p, content] of Object.entries(rego)) files[p.startsWith('system/') ? p : `liquid/${p}`] = content;
    const ontology = ((this.ontologyData as { liquid?: { ontology?: unknown } } | undefined)?.liquid?.ontology ?? {}) as Record<string, unknown>;
    const { _doc: _d, ...roleData } = roles as Record<string, unknown>;
    const data = { liquid: { ontology, roles: roleData, overlays: this.overlays.map(({ createdBy: _c, createdAt: _a, ...o }) => o) }, system: { authz: { query_token: this.queryToken() ?? '' } } };
    files['data.json'] = JSON.stringify(data);
    const revision = createHash('sha256').update(JSON.stringify(Object.entries(files).sort())).digest('hex').slice(0, 16);
    files['.manifest'] = JSON.stringify({ revision, roots: ['liquid', 'system'] });
    this.lastBundle = { revision, builtAt: new Date().toISOString(), files: Object.keys(files).filter((f) => f !== 'data.json' && f !== '.manifest').sort() };
    return { revision, body: tarGz(files) };
  }

  recordFetch(revision: string, notModified: boolean) {
    this.lastFetch = { at: new Date().toISOString(), revision, notModified };
  }

  /** OPA decision logs (gzip'd JSON array or plain JSON). Keeps the last 200, without full inputs. */
  recordDecisions(body: Buffer, gzipped: boolean) {
    const list = JSON.parse((gzipped ? gunzipSync(body) : body).toString('utf8')) as Array<{ timestamp?: string; path?: string; result?: { allow?: boolean; reason?: string; obligations?: string[] }; input?: Record<string, unknown> }>;
    for (const d of list) {
      const inp = d.input ?? {};
      const caller = (inp.caller as { agent?: string; user?: string } | undefined) ?? undefined;
      this.decisions.push({
        at: d.timestamp ?? new Date().toISOString(),
        path: d.path ?? '',
        allow: typeof d.result?.allow === 'boolean' ? d.result.allow : null,
        reason: d.result?.reason ?? null,
        obligations: d.result?.obligations ?? [],
        input: { agent: (inp.agent as { id?: string } | undefined)?.id ?? caller?.agent ?? undefined, action: inp.action as string | undefined, tool: inp.tool as string | undefined, caller: caller?.user ?? undefined },
      });
    }
    this.decisions = this.decisions.slice(-200);
  }

  status() {
    return { bundle: this.lastBundle ?? null, lastFetchByOpa: this.lastFetch ?? null, overlays: this.listOverlays(), decisions: [...this.decisions].reverse().slice(0, 50) };
  }
}
