import type pg from 'pg';
import { EventStore } from '@cw/lake';
import type { OntologyIr } from '@cw/ontology-ir';
import { types } from '@cw/ontology-sofa';
import { SCENARIO_EVENT, SCENARIO_IDS, SofaCompany, diffObjects, metaOf, objectsToWorld, worldToObjects, type Args, type Change, type CompanyMeta, type ScenarioId, type ToolResult, type WriteRecord } from '@cw/sofa-domain';
import { ddlFor, loadObjects, rowHash, runDq, seed, setMeta, upsert } from './projection.js';

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
}

export type PolicyHook = (input: { action: string; target?: string; readOnly: boolean; destructive: boolean; caller: Caller; args: Args }) => Promise<{ allow: boolean; reason?: string }>;
export const allowAll: PolicyHook = async () => ({ allow: true });

/** Caller fields the gateway injects into tool arguments (apps/mcp-gateway caller.ts). */
export const CALLER_PARAMS = ['_agent', '_task', '_requestedBy'] as const;

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

export class OntologyService {
  company!: SofaCompany;
  private readonly lock = new Mutex();
  private readonly cols = new Map<string, string[]>();

  constructor(
    private readonly pool: pg.Pool,
    readonly ir: OntologyIr,
    private readonly policy: PolicyHook = allowAll,
  ) {}

  /** Creates the projection if missing, seeds T0 once, loads the in-memory state from the projection. */
  async init() {
    await new EventStore(this.pool).migrate();
    await this.pool.query(ddlFor('projection'));
    const loaded = await loadObjects(this.pool, 'projection');
    if (!loaded.meta) {
      const t0 = new SofaCompany();
      await this.tx(async (c) => seed(c, 'projection', worldToObjects(t0.W), metaOf(t0.W, t0.seq, 0)));
      this.company = t0;
    } else this.company = new SofaCompany(objectsToWorld(loaded.objects, loaded.meta));
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
    return this.ir.actions.find((a) => a.name === name);
  }

  /** Separates the gateway's caller fields from the tool arguments. */
  static splitCaller(args: Args = {}): { args: Args; caller: Caller } {
    const rest: Args = {};
    const caller: Caller = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (k === '_agent') caller.agent = String(v);
      else if (k === '_task') caller.task = String(v);
      else if (k === '_requestedBy') caller.user = String(v);
      else rest[k] = v;
    }
    return { args: rest, caller };
  }

  /** Executes an action (MCP tools/call or REST POST /actions/:name). Never throws for bad input. */
  async execute(name: string, rawArgs: Args, caller: Caller = {}): Promise<ActionOutcome> {
    const action = this.action(name);
    if (!action) return { text: `Unknown tool ${name}`, isError: true };
    const schema = (types.ACTION_INPUTS as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }>)[name]!;
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) return { text: `Invalid input for ${name}: ${parsed.error!.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`, isError: true };
    // keep the agent's original argument object (key order and extra keys matter for answers identical to the mock)
    const args = rawArgs ?? {};
    const decision = await this.policy({ action: name, target: action.target, readOnly: action.readOnly, destructive: action.destructive, caller, args });
    if (!decision.allow) return { text: `Denied by policy: ${decision.reason ?? 'not allowed'}`, isError: true, denied: true };
    if (action.readOnly) return this.company.call(name, args);

    return this.lock.run(async () => {
      const copy = this.company.clone();
      copy.lastWrite = undefined;
      const res = copy.call(name, args);
      if (res.isError) return res; // a precondition failed: nothing is written
      const changes = diffObjects(worldToObjects(this.company.W), worldToObjects(copy.W));
      const primary = changes.find((c) => c.class === action.target)?.id ?? '-';
      const seq = await this.commit(copy, changes, {
        type: action.emits[0]!,
        objectType: action.target ?? 'Company',
        objectId: primary,
        action: name,
        caller,
        payload: { input: args, result: res.text.length > 8000 ? `${res.text.slice(0, 8000)}…` : res.text, log: copy.lastWrite ?? null },
      });
      return { ...res, seq };
    });
  }

  private async commit(next: SofaCompany, changes: Change[], e: { type: string; objectType: string; objectId: string; action?: string; caller: Caller; payload: Record<string, unknown> }): Promise<number> {
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
          payload: { ...e.payload, changes, meta },
          ontologyVersion: this.ir.version,
        },
      ]);
      await upsert(c, 'projection', changes, r!.seq, this.cols);
      await setMeta(c, 'projection', meta, r!.seq);
      return r!.seq;
    });
    this.company = next;
    return seq;
  }

  /** Starts a scenario disruption of the parity runner (written as an event like any other change). */
  async scenario(id: string, caller: Caller = {}) {
    if (!(SCENARIO_IDS as readonly string[]).includes(id)) throw Object.assign(new Error(`unknown scenario ${id}`), { status: 404, known: SCENARIO_IDS });
    return this.lock.run(async () => {
      const copy = this.company.clone();
      copy.scenario(id as ScenarioId);
      const changes = diffObjects(worldToObjects(this.company.W), worldToObjects(copy.W));
      const ev = SCENARIO_EVENT[id]!;
      const seq = await this.commit(copy, changes, { ...ev, caller: { agent: caller.agent ?? 'scenario-runner', ...caller }, payload: { scenario: id } });
      return { ok: true, scenario: id, seq, kpi: this.company.kpi() };
    });
  }

  /** Back to the undisturbed baseline (parity runner): an event whose changes restore T0. */
  async reset(caller: Caller = {}) {
    return this.lock.run(async () => {
      const fresh = new SofaCompany();
      const changes = diffObjects(worldToObjects(this.company.W), worldToObjects(fresh.W));
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
    return this.lock.run(async () => {
      const scratch = 'projection_rebuild';
      await this.pool.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
      await this.pool.query(ddlFor(scratch));
      const t0 = new SofaCompany();
      await this.tx((c) => seed(c, scratch, worldToObjects(t0.W), metaOf(t0.W, t0.seq, 0)));
      const cols = new Map<string, string[]>();
      let applied = 0;
      let last = 0;
      for (;;) {
        const r = await this.pool.query<{ seq: number; changes: Change[] | null; meta: CompanyMeta | null }>(`SELECT seq, payload->'changes' AS changes, payload->'meta' AS meta FROM events WHERE seq > $1 AND payload ? 'changes' ORDER BY seq LIMIT 500`, [last]);
        if (!r.rows.length) break;
        await this.tx(async (c) => {
          for (const e of r.rows) {
            await upsert(c, scratch, e.changes ?? [], Number(e.seq), cols);
            if (e.meta) await setMeta(c, scratch, e.meta, Number(e.seq));
            applied++;
          }
        });
        last = Number(r.rows.at(-1)!.seq);
      }
      const live = await rowHash(this.pool, 'projection');
      const rebuilt = await rowHash(this.pool, scratch);
      const identical = live.hash === rebuilt.hash;
      if (!opts.dryRun) {
        await this.tx(async (c) => {
          await c.query('DROP SCHEMA projection CASCADE');
          await c.query(`ALTER SCHEMA ${scratch} RENAME TO projection`);
        });
        const loaded = await loadObjects(this.pool, 'projection');
        this.company = new SofaCompany(objectsToWorld(loaded.objects, loaded.meta!));
      } else await this.pool.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
      return { eventsApplied: applied, lastSeq: last, identical, live: live.hash, rebuilt: rebuilt.hash, tables: rebuilt.tables, swapped: !opts.dryRun };
    });
  }

  dq() {
    return runDq(this.pool, 'projection');
  }
}
