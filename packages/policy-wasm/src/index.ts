import { createHash } from 'node:crypto';
import { loadPolicy } from '@open-policy-agent/opa-wasm';

/*
 * Policy as code, embedded (ADR-0049): the reconciler compiles policies/liquid/*.rego to WebAssembly (entrypoints
 * liquid/gateway/decision and liquid/object/decision); the control plane serves it with the data (ontology, roles,
 * overlays) as one package; the MCP gateway and the enterprise core evaluate it in-process. No OPA service, no network
 * call per decision. Fail closed: no package loaded, an evaluation error or no result deny.
 *
 * Builtins the WASM module does not implement itself are provided by the host (verified for these policies:
 * time.now_ns, time.parse_rfc3339_ns; sprintf, concat, sort, object.get, count, union, is_string are built in).
 */

export const GATEWAY_ENTRY = 'liquid/gateway/decision';
export const OBJECT_ENTRY = 'liquid/object/decision';

export interface PolicyPackage {
  /** Content hash of wasm + data. */
  revision: string;
  /** policy.wasm, base64. */
  wasm: string;
  /** The data document: { liquid: { ontology, roles, overlays } }. */
  data: Record<string, unknown>;
  builtAt?: string;
}

export interface Decision {
  allow: boolean;
  reason: string;
  obligations: string[];
}

const HOST_BUILTINS = {
  'time.now_ns': () => Date.now() * 1e6,
  'time.parse_rfc3339_ns': (s: unknown) => {
    const t = Date.parse(String(s));
    if (Number.isNaN(t)) throw new Error(`time.parse_rfc3339_ns: invalid time ${String(s)}`);
    return t * 1e6;
  },
};

export const packageRevision = (wasm: string, data: unknown) => createHash('sha256').update(wasm).update(JSON.stringify(data)).digest('hex').slice(0, 16);

type Loaded = Awaited<ReturnType<typeof loadPolicy>>;

export class PolicyEngine {
  private policy?: Loaded;
  private wasmHash?: string;
  revision?: string;
  loadedAt?: string;
  lastError?: string;

  get loaded() {
    return !!this.policy;
  }

  /** Loads a package; the WASM module is only re-instantiated when it changed (data updates are cheap). */
  async load(pkg: PolicyPackage): Promise<void> {
    const h = createHash('sha256').update(pkg.wasm).digest('hex');
    let policy = this.policy;
    if (!policy || h !== this.wasmHash) policy = await loadPolicy(Buffer.from(pkg.wasm, 'base64'), undefined, HOST_BUILTINS);
    policy.setData(pkg.data);
    this.policy = policy;
    this.wasmHash = h;
    this.revision = pkg.revision;
    this.loadedAt = new Date().toISOString();
    this.lastError = undefined;
  }

  decide(entry: typeof GATEWAY_ENTRY | typeof OBJECT_ENTRY, input: unknown): Decision {
    if (!this.policy) return { allow: false, reason: 'no policy loaded yet (fail closed)', obligations: [] };
    try {
      const r = this.policy.evaluate(input, entry) as Array<{ result?: { allow?: unknown; reason?: unknown; obligations?: unknown } }> | undefined;
      const d = r?.[0]?.result;
      if (!d || typeof d.allow !== 'boolean') return { allow: false, reason: 'the policy returned no decision (fail closed)', obligations: [] };
      return { allow: d.allow, reason: typeof d.reason === 'string' ? d.reason : '', obligations: Array.isArray(d.obligations) ? d.obligations.map(String) : [] };
    } catch (err) {
      this.lastError = String(err);
      return { allow: false, reason: `policy evaluation failed: ${String(err).slice(0, 160)} (fail closed)`, obligations: [] };
    }
  }
}

/**
 * Keeps an engine up to date by polling the control plane (ETag). Errors keep the last good package (or none = deny).
 */
export function pollPolicy(o: { url: string; token: () => string | undefined; engine: PolicyEngine; intervalMs?: number; onLoad?: (rev: string) => void; onError?: (err: string) => void; fetchImpl?: typeof fetch }) {
  const f = o.fetchImpl ?? fetch;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      const token = o.token();
      if (token) {
        const res = await f(o.url, { headers: { authorization: `Bearer ${token}`, ...(o.engine.revision ? { 'if-none-match': `"${o.engine.revision}"` } : {}) }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 200) {
          const pkg = (await res.json()) as PolicyPackage;
          await o.engine.load(pkg);
          o.onLoad?.(pkg.revision);
        } else if (res.status !== 304 && res.status !== 404) o.onError?.(`policy package: HTTP ${res.status}`);
      }
    } catch (err) {
      o.engine.lastError = String(err);
      o.onError?.(String(err));
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), o.intervalMs ?? 5000);
      timer.unref?.();
    }
  };
  void tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    refresh: tick,
  };
}
