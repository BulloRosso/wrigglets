import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { packageRevision, type PolicyPackage } from '@cw/policy-wasm';

/*
 * Policy as code, control-plane side (ADR-0044, embedded since ADR-0049):
 *   - tightening overlays (data.liquid.overlays): added by admins and playbooks (tighten automatically), removed only
 *     by a person (loosen with approval);
 *   - the policy package: the Rego policies of the applied config revision compiled to WebAssembly (compiler service),
 *     plus the data document (ontology from the enterprise core, roles, overlays), with a content revision. The MCP
 *     gateway and the enterprise core poll it (ETag) and evaluate it in-process — no OPA service;
 *   - recent decisions are events in the event log (PolicyDecision, GatewayToolCall), read for the Policies page.
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

export type CompileWasm = (files: Record<string, string>) => Promise<{ ok: boolean; wasm?: string; errors?: Array<{ path: string; message: string }> }>;

/* ---------------------------------------------------------------------------------------------- service */

export class LiquidPolicyService {
  private overlays: Overlay[] = [];
  private readonly file: string;
  private ontologyData: unknown;
  private wasm?: { hash: string; wasm: string };
  private last?: PolicyPackage;
  private lastError?: string;
  private fetches = new Map<string, { at: string; revision: string; notModified: boolean }>();

  constructor(
    dataDir: string,
    private readonly policyDir: string,
    private readonly fetchOntologyData: () => Promise<unknown>,
    private readonly compileWasm: CompileWasm,
    /** Recent policy decisions from the event log (PolicyDecision / GatewayToolCall events). */
    private readonly recentDecisions: () => Promise<DecisionLogEntry[]> = async () => [],
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
  }

  listOverlays(): Overlay[] {
    return [...this.overlays];
  }

  /** Tightening: always allowed for an authorised caller (admin, playbooks). */
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

  /** Config repository (ADR-0046): the overlays of the applied revision replace the store. */
  async replaceOverlays(list: Overlay[]) {
    this.overlays = list.map((o) => ({ ...o }));
    await this.persist();
  }

  /** The policies come from the applied revision of the config repository when it exists (M6). */
  policySource?: () => Promise<Record<string, string> | undefined>;

  /** Rego and data files relative to policies/ (e.g. liquid/object.rego), tests excluded, and the roles. */
  private async policyFiles(): Promise<{ rego: Record<string, string>; roles: unknown }> {
    const fromRepo = await this.policySource?.().catch(() => undefined);
    if (fromRepo && Object.keys(fromRepo).some((p) => p.endsWith('.rego'))) {
      const rego: Record<string, string> = {};
      for (const [p, text] of Object.entries(fromRepo)) {
        const rel = p.replace(/^policies\//, '');
        if (rel.endsWith('.rego') && !rel.endsWith('_test.rego') && !rel.startsWith('liquid/system/')) rego[rel] = text;
      }
      const roles = fromRepo['policies/liquid/roles/data.json'] ? JSON.parse(fromRepo['policies/liquid/roles/data.json']) : { roles: {}, agents: {} };
      return { rego, roles };
    }
    const rego: Record<string, string> = {};
    const walk = async (dir: string, rel: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (r !== 'system') await walk(p, r);
        } else if (e.name.endsWith('.rego') && !e.name.endsWith('_test.rego')) rego[`liquid/${r}`] = await readFile(p, 'utf8');
      }
    };
    await walk(this.policyDir, '');
    const rolesPath = path.join(this.policyDir, 'roles', 'data.json');
    const roles = existsSync(rolesPath) ? JSON.parse(await readFile(rolesPath, 'utf8')) : { roles: {}, agents: {} };
    return { rego, roles };
  }

  /**
   * The policy package: WASM (compiled when the Rego changed) + data. Compile errors keep the last good WASM: a broken
   * policy never replaces a working one (proposals validate with opa check/test before they can be approved).
   */
  /**
   * Waits until the given consumers fetched the current package (built now from the current data). The reconciler
   * calls it after an ontology change: "live" then means every enforcement point knows the new actions (ADR-0052).
   */
  async waitConverged(consumers: string[], timeoutMs = 30_000): Promise<boolean> {
    const rev = (await this.package()).revision;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (consumers.every((c) => this.fetches.get(c)?.revision === rev)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async package(): Promise<PolicyPackage> {
    try {
      this.ontologyData = (await this.fetchOntologyData()) ?? this.ontologyData;
    } catch {
      /* enterprise core not reachable: keep the last known data (none = unknown actions are denied) */
    }
    const { rego, roles } = await this.policyFiles();
    const hash = createHash('sha256').update(JSON.stringify(Object.entries(rego).sort())).digest('hex');
    if (this.wasm?.hash !== hash) {
      const out = await this.compileWasm(rego).catch((err: Error) => ({ ok: false, errors: [{ path: 'compiler', message: err.message }] }) as Awaited<ReturnType<CompileWasm>>);
      if (out.ok && out.wasm) {
        this.wasm = { hash, wasm: out.wasm };
        this.lastError = undefined;
      } else {
        this.lastError = (out.errors ?? []).map((e) => `${e.path}: ${e.message}`).join('; ') || 'compile failed';
        if (!this.wasm) throw new Error(`policy compile failed: ${this.lastError}`);
      }
    }
    const ontology = ((this.ontologyData as { liquid?: { ontology?: unknown } } | undefined)?.liquid?.ontology ?? {}) as Record<string, unknown>;
    const { _doc: _d, ...roleData } = roles as Record<string, unknown>;
    const data = { liquid: { ontology, roles: roleData, overlays: this.overlays.map(({ createdBy: _c, createdAt: _a, ...o }) => o) } };
    const revision = packageRevision(this.wasm!.wasm, data);
    if (this.last?.revision !== revision) this.last = { revision, wasm: this.wasm!.wasm, data, builtAt: new Date().toISOString() };
    return this.last;
  }

  recordFetch(consumer: string, revision: string, notModified: boolean) {
    this.fetches.set(consumer, { at: new Date().toISOString(), revision, notModified });
  }

  async status() {
    return {
      bundle: this.last ? { revision: this.last.revision, builtAt: this.last.builtAt, files: Object.keys((await this.policyFiles()).rego).sort(), engine: 'wasm' } : null,
      compileError: this.lastError ?? null,
      consumers: Object.fromEntries(this.fetches),
      lastFetchByOpa: this.fetches.get('gateway') ?? this.fetches.get('core') ?? null,
      overlays: this.listOverlays(),
      decisions: await this.recentDecisions().catch(() => []),
    };
  }
}
