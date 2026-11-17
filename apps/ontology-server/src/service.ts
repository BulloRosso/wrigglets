import { evaluateChecks, replayPrecondition } from './checks.js';
import type pg from 'pg';
import { EventStore } from '@cw/lake';
import { compatibility, inputValidator, resolveAction, verifyIr, type Compatibility, type OntologyIr } from '@cw/ontology-ir';
import { SCENARIO_EVENT, SCENARIO_IDS, SofaCompany, diffObjects, metaOf, objectsToWorld, worldToObjects, type Args, type Change, type CompanyMeta, type Objects, type ScenarioId, type ToolResult, type WriteRecord } from '@cw/sofa-domain';
import { ddlFor, loadObjects, rowHash, runDq, seed, setMeta, upsert } from './projection.js';
import { cloneExt, identifierIn, domainModel, emptyExt, extFromObjects, genericAction, migrationSql, objectsOf, type DomainModel, type Ext } from './runtime.js';
import { shadowReplay, type Candidate } from './shadow.js';

/*
 * The action pipeline (ADR-0043): the ONLY write path for business data. One code path for MCP and REST:
 *   validate input (generated zod) -> policy hook (M4) -> handler on a copy of the state (domain package)
 *   -> precondition failure = answer without any write
 *   -> success = ONE transaction: append the event (input, answer, changed objects, company values) + update the
 *      projection -> swap the in-memory state. Read-only actions never write.
 * Scenario disruptions and the simulation reset of the parity runner go through the same transaction, as events.
 */

export interface Caller {
  agent?: string;
  user?: string;
  task?: string;
  workflow?: string;
  /** Task step (plan | run | fix) as the gateway knows it; run/fix = a person approved the plan. */
  step?: string;
  /** Person who approved a four-eyes request (ApprovalWorkflow). Accepted only from trusted callers (REST + internal token), never from MCP. */
  approvedBy?: string;
  /** Registered app the person used (app host of the control plane, ADR-0050). Trusted callers only, never from MCP. */
  app?: string;
}

export type PolicyHook = (input: { action: string; target?: string; readOnly: boolean; destructive: boolean; caller: Caller; args: Args; company: SofaCompany; ir: OntologyIr; objects: Objects }) => Promise<{ allow: boolean; reason?: string; obligations?: string[] }>;
export const allowAll: PolicyHook = async () => ({ allow: true });

/** Caller fields the gateway injects into tool arguments (apps/mcp-gateway caller.ts). */
export const CALLER_PARAMS = ['_agent', '_task', '_requestedBy', '_step'] as const;

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface ActionOutcome extends ToolResult {
  /** seq of the event written (writes only). */
  seq?: number;
  denied?: boolean;
}

const RESET_EVENT = 'SimulationReset';

const cmpVersion = (x: string, y: string) => {
  const p = x.split('.').map(Number);
  const q = y.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return (p[i] ?? 0) - (q[i] ?? 0);
  return 0;
};

export class OntologyService {
  company!: SofaCompany;
  /** The ontology version in force (ADR-0048): replaced at runtime by apply(), persisted in ontology_versions. */
  ir: OntologyIr;
  /** Objects and attributes of newer ontology versions the domain code does not know. */
  ext: Ext = emptyExt();
  private readonly dm: DomainModel;
  private readonly lock = new Mutex();
  private cols = new Map<string, string[]>();

  constructor(
    private readonly pool: pg.Pool,
    /** The ontology the domain code was written for (built into the image). */
    readonly builtin: OntologyIr,
    private readonly policy: PolicyHook = allowAll,
  ) {
    this.ir = builtin;
    this.dm = domainModel(builtin);
  }

  /** Current objects of every class of the current ontology (domain world + extension state). */
  objects(company: SofaCompany = this.company, ext: Ext = this.ext): Objects {
    return objectsOf(company.W, ext, this.ir, this.dm);
  }

  /** Creates the projection if missing, seeds T0 once, loads the in-memory state from the projection. */
  async init() {
    await new EventStore(this.pool).migrate();
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ontology_versions (seq bigserial PRIMARY KEY, version text NOT NULL, hash text NOT NULL, level text NOT NULL, note text, ir jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // the version in force: the last applied one, unless the image brings a newer built-in ontology
    const last = (await this.pool.query<{ ir: OntologyIr }>('SELECT ir FROM ontology_versions ORDER BY seq DESC LIMIT 1')).rows[0]?.ir;
    if (last && cmpVersion(last.version, this.builtin.version) >= 0) this.ir = verifyIr(last);
    else {
      this.ir = this.builtin;
      if (!last || last.hash !== this.builtin.hash) await this.pool.query('INSERT INTO ontology_versions (version, hash, level, note, ir) VALUES ($1, $2, $3, $4, $5::jsonb)', [this.builtin.version, this.builtin.hash, 'image', 'built-in ontology of this image', JSON.stringify(this.builtin)]);
    }
    for (const sql of last && last.hash !== this.ir.hash ? migrationSql('projection', last, this.ir) : [ddlFor('projection', this.ir)]) await this.pool.query(sql);
    const loaded = await loadObjects(this.pool, 'projection', this.ir);
    if (!loaded.meta) {
      const t0 = new SofaCompany();
      await this.tx(async (c) => seed(c, 'projection', worldToObjects(t0.W), metaOf(t0.W, t0.seq, 0), this.ir));
      this.company = t0;
      this.ext = emptyExt();
    } else {
      this.company = new SofaCompany(objectsToWorld(loaded.objects, loaded.meta));
      this.ext = extFromObjects(loaded.objects, this.ir, this.dm);
    }
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  action(name: string) {
    return resolveAction(this.ir, name)?.action;
  }

  /** Separates the gateway's caller fields from the tool arguments. */
  static splitCaller(args: Args = {}): { args: Args; caller: Caller } {
    const rest: Args = {};
    const caller: Caller = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (k === '_agent') caller.agent = String(v);
      else if (k === '_task') caller.task = String(v);
      else if (k === '_requestedBy') caller.user = String(v);
      else if (k === '_step') caller.step = String(v);
      else if (k === '_workflow') caller.workflow = String(v);
      else if (k === '_approvedBy') caller.approvedBy = String(v);
      else if (k === '_app') caller.app = String(v);
      else rest[k] = v;
    }
    return { args: rest, caller };
  }

  /** Executes an action (MCP tools/call or REST POST /actions/:name). Never throws for bad input. */
  async execute(name: string, rawArgs: Args, caller: Caller = {}): Promise<ActionOutcome> {
    const resolved = resolveAction(this.ir, name);
    if (!resolved) return { text: `Unknown tool ${name}`, isError: true };
    const action = resolved.action;
    // a deprecated alias runs the action under its current name; the event records the alias
    if (resolved.viaAlias) name = action.name;
    const schema = inputValidator(this.ir, action.name)!;
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) return { text: `Invalid input for ${name}: ${parsed.error!.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`, isError: true };
    // keep the agent's original argument object (key order and extra keys matter for answers identical to the mock)
    const args = rawArgs ?? {};
    const decision = await this.policy({ action: name, target: action.target, readOnly: action.readOnly, destructive: action.destructive, caller, args, company: this.company, ir: this.ir, objects: this.objects() });
    if (!decision.allow) {
      // denials are events: audit is a query over the event log (ADR-0049)
      await new EventStore(this.pool)
        .append([{ type: 'PolicyDecision', objectType: action.target ?? 'Company', objectId: '-', action: name, actorAgent: caller.agent, actorUser: caller.user, taskId: caller.task, workflowId: caller.workflow, payload: { point: 'object', allow: false, reason: decision.reason ?? null, obligations: decision.obligations ?? [] }, ontologyVersion: this.ir.version }])
        .catch(() => undefined);
      return { text: `Denied by policy: ${decision.reason ?? 'not allowed'}`, isError: true, denied: true };
    }
    const obligations = decision.obligations ?? [];
    if (obligations.includes('require_step_up')) return { text: 'Denied by policy: this action requires a step-up authentication of the person (not available in the prototype)', isError: true, denied: true };
    if (obligations.includes('require_four_eyes')) return this.requestApproval(action.name, action.target, args, caller, decision.reason);
    // core checks the ontology switches on for this action (D3): a refusal writes nothing, like a domain precondition
    if (!action.readOnly) {
      const refusals = evaluateChecks(action.preconditions ?? [], { args, objects: this.objects() });
      if (refusals.length) return { text: refusals.join('; '), isError: true };
    }
    // actions of newer ontology versions without domain code run generically from the IR (ADR-0048)
    const coded = this.company.has(name);
    if (action.readOnly) return coded ? this.company.call(name, args) : genericAction(this.ir, this.dm, name, args, this.company.W, this.ext);

    return this.lock.run(async () => {
      const copy = this.company.clone();
      copy.lastWrite = undefined;
      const ext = cloneExt(this.ext);
      const res = coded ? copy.call(name, args) : genericAction(this.ir, this.dm, name, args, copy.W, ext);
      if (res.isError) return res; // a precondition failed: nothing is written
      const changes = diffObjects(this.objects(), this.objects(copy, ext), (c) => identifierIn(this.ir, c));
      const primary = changes.find((c) => c.class === action.target)?.id ?? '-';
      const seq = await this.commit(copy, changes, {
        type: action.emits[0]!,
        objectType: action.target ?? 'Company',
        objectId: primary,
        action: name,
        caller,
        payload: { input: args, result: res.text.length > 8000 ? `${res.text.slice(0, 8000)}…` : res.text, log: copy.lastWrite ?? null, ...(resolved.viaAlias ? { viaAlias: resolved.viaAlias } : {}), ...(coded ? {} : { generic: true }) },
      }, ext);
      return { ...res, seq };
    });
  }

  /**
   * Four eyes (ADR-0044): the action is not run; the request is recorded as an event (no changes) and waits for a person.
   * The approval workflow that runs it after approval is part of M5 (ApprovalWorkflow).
   */
  private async requestApproval(action: string, target: string | undefined, args: Args, caller: Caller, reason?: string): Promise<ActionOutcome> {
    const [r] = await new EventStore(this.pool).append([
      { type: 'ActionApprovalRequested', objectType: target ?? 'Company', objectId: '-', action, actorAgent: caller.agent, actorUser: caller.user, taskId: caller.task, workflowId: caller.workflow, payload: { input: args, obligation: 'require_four_eyes', reason: reason ?? null, step: caller.step ?? null }, ontologyVersion: this.ir.version },
    ]);
    return { text: `Pending approval (four eyes): ${action} needs a person's approval before it runs (approval request ${r!.seq}). Nothing was changed yet.`, isError: true, denied: true, seq: r!.seq };
  }

  private async commit(next: SofaCompany, changes: Change[], e: { type: string; objectType: string; objectId: string; action?: string; caller: Caller; payload: Record<string, unknown> }, ext: Ext = this.ext): Promise<number> {
    const meta = metaOf(next.W, next.seq, next.writes);
    const seq = await this.tx(async (c) => {
      const [r] = await new EventStore(c).append([
        {
          type: e.type,
          objectType: e.objectType,
          objectId: e.objectId,
          action: e.action,
          actorAgent: e.caller.agent,
          actorUser: e.caller.user,
          taskId: e.caller.task,
          workflowId: e.caller.workflow,
          payload: { ...e.payload, ...(e.caller.approvedBy ? { approvedBy: e.caller.approvedBy } : {}), ...(e.caller.app ? { app: e.caller.app } : {}), changes, meta },
          ontologyVersion: this.ir.version,
        },
      ]);
      await upsert(c, 'projection', changes, r!.seq, this.cols, this.ir);
      await setMeta(c, 'projection', meta, r!.seq);
      return r!.seq;
    });
    this.company = next;
    this.ext = ext;
    return seq;
  }

  /** The event log replayed with a candidate configuration (ADR-0047); read-only. */
  /** The core checks an action would run now, without running it (v2 workflow gates). */
  checkPreconditions(name: string, args: Args): { ok: boolean; reasons: string[] } {
    const action = resolveAction(this.ir, name)?.action;
    if (!action) return { ok: false, reasons: [`unknown action ${name}`] };
    const reasons = evaluateChecks(action.preconditions ?? [], { args, objects: this.objects() });
    return { ok: reasons.length === 0, reasons };
  }

  /** Shadow replay of a precondition over the releases of a window, with assumed attribute values (D3 evidence). */
  async shadowPrecondition(o: { action: string; precondition: string; windowMs?: number; assume?: Record<string, Record<string, Record<string, unknown>>> }) {
    const windowMs = o.windowMs ?? 7 * 86_400_000;
    const rows = (await this.pool.query<{ seq: string; object_id: string; changes: Array<{ class: string; id: string; after: Record<string, unknown> | null }> | null }>(
      "SELECT seq, object_id, payload->'changes' AS changes FROM events WHERE action = $1 AND recorded_at > now() - ($2 || ' milliseconds')::interval ORDER BY seq",
      [o.action, String(windowMs)],
    )).rows;
    const events = rows.map((r) => ({ seq: Number(r.seq), objectId: r.object_id, order: (r.changes ?? []).find((c) => c.class === 'PurchaseOrder' && c.id === r.object_id)?.after ?? null }));
    return { action: o.action, precondition: o.precondition, windowMs, ...replayPrecondition({ precondition: o.precondition, events, objects: this.objects(), assume: o.assume }) };
  }

  shadowReplay(o: { windowMs?: number; fromSeq?: number; toSeq?: number; candidate?: Candidate }) {
    return shadowReplay(this.pool, this.ir, o);
  }

  /** Starts a scenario disruption of the parity runner (written as an event like any other change). */
  async scenario(id: string, caller: Caller = {}) {
    if (!(SCENARIO_IDS as readonly string[]).includes(id)) throw Object.assign(new Error(`unknown scenario ${id}`), { status: 404, known: SCENARIO_IDS });
    return this.lock.run(async () => {
      const copy = this.company.clone();
      copy.scenario(id as ScenarioId);
      const changes = diffObjects(this.objects(), this.objects(copy));
      const ev = SCENARIO_EVENT[id]!;
      const seq = await this.commit(copy, changes, { ...ev, caller: { agent: caller.agent ?? 'scenario-runner', ...caller }, payload: { scenario: id } });
      return { ok: true, scenario: id, seq, kpi: this.company.kpi() };
    });
  }

  /** Back to the undisturbed baseline (parity runner): an event whose changes restore T0. */
  async reset(caller: Caller = {}) {
    return this.lock.run(async () => {
      const fresh = new SofaCompany();
      const changes = diffObjects(this.objects(), this.objects(fresh));
      const seq = await this.commit(fresh, changes, { type: RESET_EVENT, objectType: 'Company', objectId: 'sofa', caller: { agent: caller.agent ?? 'scenario-runner', ...caller }, payload: {} });
      return { ok: true, seq, kpi: this.company.kpi() };
    });
  }

  /** The mock's /log: every write since the last reset (tool, args, result, time). */
  async writeLog(): Promise<Array<{ at: string; tool: string; args: Args; result: string }>> {
    const r = await this.pool.query<{ occurred_at: Date | string; log: WriteRecord }>(
      `SELECT occurred_at, payload->'log' AS log FROM events WHERE seq > coalesce((SELECT max(seq) FROM events WHERE type = $1), 0) AND payload ? 'log' AND payload->'log' <> 'null'::jsonb ORDER BY seq`,
      [RESET_EVENT],
    );
    return r.rows.map((x) => ({ at: new Date(x.occurred_at).toISOString(), tool: x.log.tool, args: x.log.args, result: x.log.result }));
  }

  /** Rebuilds the projection from T0 and the event log into a scratch schema; swaps it in unless `dryRun`. */
  async rebuild(opts: { dryRun?: boolean } = {}) {
    return this.lock.run(() => this.rebuildUnlocked(this.ir, opts));
  }

  /** Rebuild into a scratch schema with the DDL of `ir` (also the migration path of breaking ontology changes). */
  private async rebuildUnlocked(ir: OntologyIr, opts: { dryRun?: boolean } = {}) {
    {
      const scratch = 'projection_rebuild';
      await this.pool.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
      await this.pool.query(ddlFor(scratch, ir));
      const t0 = new SofaCompany();
      await this.tx((c) => seed(c, scratch, worldToObjects(t0.W), metaOf(t0.W, t0.seq, 0), ir));
      const cols = new Map<string, string[]>();
      let applied = 0;
      let last = 0;
      for (;;) {
        const r = await this.pool.query<{ seq: number; changes: Change[] | null; meta: CompanyMeta | null }>(`SELECT seq, payload->'changes' AS changes, payload->'meta' AS meta FROM events WHERE seq > $1 AND payload ? 'changes' ORDER BY seq LIMIT 500`, [last]);
        if (!r.rows.length) break;
        await this.tx(async (c) => {
          for (const e of r.rows) {
            await upsert(c, scratch, e.changes ?? [], Number(e.seq), cols, ir);
            if (e.meta) await setMeta(c, scratch, e.meta, Number(e.seq));
            applied++;
          }
        });
        last = Number(r.rows.at(-1)!.seq);
      }
      const live = await rowHash(this.pool, 'projection', this.ir).catch(() => ({ hash: '', tables: {} }));
      const rebuilt = await rowHash(this.pool, scratch, ir);
      const identical = live.hash === rebuilt.hash;
      if (!opts.dryRun) {
        await this.tx(async (c) => {
          await c.query('DROP SCHEMA projection CASCADE');
          await c.query(`ALTER SCHEMA ${scratch} RENAME TO projection`);
        });
        const loaded = await loadObjects(this.pool, 'projection', ir);
        this.company = new SofaCompany(objectsToWorld(loaded.objects, loaded.meta!));
        this.ext = extFromObjects(loaded.objects, ir, this.dm);
        this.cols = new Map();
      } else await this.pool.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
      return { eventsApplied: applied, lastSeq: last, identical, live: live.hash, rebuilt: rebuilt.hash, tables: rebuilt.tables, swapped: !opts.dryRun };
    }
  }

  dq() {
    return runDq(this.pool, this.ir, 'projection');
  }

  /* ---------------------------------------------------------------------------------- ontology evolution (M8) */

  /** What applying `next` would do: compatibility + data checks against the current projection. */
  async check(nextRaw: unknown): Promise<{ compatibility: Compatibility; data: { ok: boolean; findings: Array<{ path: string; problem: string; rows: number }> } }> {
    const next = verifyIr(nextRaw);
    const compat = compatibility(this.ir, next);
    const objects = this.objects();
    const findings: Array<{ path: string; problem: string; rows: number }> = [];
    for (const c of next.classes) {
      const rows = objects[c.name] ?? [];
      if (!rows.length) continue;
      for (const a of c.attributes) {
        if (a.required && !a.identifier) {
          const n = rows.filter((r) => r[a.name] === undefined || r[a.name] === null).length;
          if (n) findings.push({ path: `${c.name}.${a.name}`, problem: 'required but empty in existing objects', rows: n });
        }
        if (a.rangeKind === 'enum') {
          const allowed = new Set(next.enums.find((e) => e.name === a.range)?.values.map((v) => v.value) ?? []);
          const n = rows.filter((r) => (Array.isArray(r[a.name]) ? (r[a.name] as unknown[]) : r[a.name] == null ? [] : [r[a.name]]).some((v) => !allowed.has(String(v)))).length;
          if (n) findings.push({ path: `${c.name}.${a.name}`, problem: `values outside ${a.range}`, rows: n });
        }
      }
    }
    for (const c of this.ir.classes) if (!next.classes.some((x) => x.name === c.name) && (objects[c.name] ?? []).length) findings.push({ path: c.name, problem: 'class removed but has objects (they stay in the event log)', rows: objects[c.name]!.length });
    return { compatibility: compat, data: { ok: findings.length === 0, findings } };
  }

  /**
   * Applies a new ontology version while running (ADR-0048): additive → DDL migration in place; breaking → rebuild of
   * the projection from the events with the new DDL, then swap. Between two actions (same lock), so no request is lost.
   */
  async apply(nextRaw: unknown, opts: { allowBreaking?: boolean; note?: string; by?: string } = {}) {
    const next = verifyIr(nextRaw);
    if (next.hash === this.ir.hash) return { applied: false, version: next.version, reason: 'already in force' };
    if (next.name !== this.ir.name) throw Object.assign(new Error(`ontology ${next.name} is not ${this.ir.name}`), { status: 422 });
    const compat = compatibility(this.ir, next);
    if (compat.level === 'major' && !opts.allowBreaking) throw Object.assign(new Error(`breaking change (${compat.findings.filter((f) => f.level === 'major').map((f) => `${f.path}: ${f.reason}`).join('; ')}) needs a migration note`), { status: 409 });
    return this.lock.run(async () => {
      const from = this.ir;
      let migration: 'alter' | 'rebuild';
      // classes or attributes that come back (removed earlier, events still there) are backfilled: the events are the
      // truth, so an additive change with history is migrated by a rebuild too
      const history = await this.hasHistory(from, next);
      if (compat.level === 'major' || history) {
        await this.rebuildUnlocked(next);
        migration = 'rebuild';
      } else {
        await this.tx(async (c) => {
          for (const sql of migrationSql('projection', from, next)) await c.query(sql);
        });
        migration = 'alter';
        this.cols = new Map();
      }
      await this.pool.query('INSERT INTO ontology_versions (version, hash, level, note, ir) VALUES ($1, $2, $3, $4, $5::jsonb)', [next.version, next.hash, compat.level, opts.note ?? null, JSON.stringify(next)]);
      this.ir = next;
      if (migration === 'alter') this.ext = extFromObjects(this.objects(), next, this.dm);
      const [r] = await new EventStore(this.pool).append([
        { type: 'OntologyVersionApplied', objectType: 'Ontology', objectId: `${next.name}@${next.version}`, actorUser: opts.by, payload: { from: from.version, to: next.version, hash: next.hash, level: compat.level, migration, findings: compat.findings, note: opts.note ?? null }, ontologyVersion: next.version },
      ]);
      return { applied: true, from: from.version, to: next.version, level: compat.level, migration, seq: r!.seq };
    });
  }

  /** Do events already carry data of a class or attribute that `next` adds? */
  private async hasHistory(from: OntologyIr, next: OntologyIr): Promise<boolean> {
    for (const c of next.classes) {
      const before = from.classes.find((x) => x.name === c.name);
      const added = before ? c.attributes.filter((a) => !before.attributes.some((b) => b.name === a.name)).map((a) => a.name) : null;
      if (added && !added.length) continue;
      const r = added
        ? await this.pool.query("SELECT 1 FROM events e, jsonb_array_elements(e.payload->'changes') ch WHERE e.payload ? 'changes' AND ch->>'class' = $1 AND ch->'after' IS NOT NULL AND jsonb_typeof(ch->'after') = 'object' AND EXISTS (SELECT 1 FROM unnest($2::text[]) k WHERE ch->'after' ? k AND ch->'after'->>k IS NOT NULL) LIMIT 1", [c.name, added])
        : await this.pool.query("SELECT 1 FROM events e, jsonb_array_elements(e.payload->'changes') ch WHERE e.payload ? 'changes' AND ch->>'class' = $1 LIMIT 1", [c.name]);
      if (r.rows.length) return true;
    }
    return false;
  }

  async versions() {
    return (await this.pool.query<{ version: string; hash: string; level: string; note: string | null; applied_at: string }>('SELECT version, hash, level, note, applied_at FROM ontology_versions ORDER BY seq DESC LIMIT 50')).rows;
  }
}
