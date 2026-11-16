import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { OntologyIr } from '@cw/ontology-ir';
import { SofaCompany, applyChanges, diffObjects, metaOf, objectsToWorld, worldToObjects, type Change, type CompanyMeta, type Objects } from '@cw/sofa-domain';

/*
 * Shadow replay (ADR-0047): the event log replayed with a candidate configuration. The state at the start of the window
 * is folded from the events (T0 + changes), then every action of the window is re-run on a shadow copy under the
 * candidate (overlays that deny or require four eyes, disabled actions); other changes (scenarios, resets) are applied
 * as recorded. The report compares shadow and actual: blocked actions, diverging results, KPI delta. Deterministic:
 * same window + same candidate ⇒ identical report (no clocks, no randomness).
 */

export interface Candidate {
  overlays?: Array<{ effect: 'deny' | 'require_four_eyes' | 'require_step_up'; match: { actions?: string[]; classes?: string[]; agents?: string[] } }>;
  disabledActions?: string[];
}

interface Ev {
  seq: number;
  type: string;
  action: string | null;
  actor_agent: string | null;
  payload: { input?: Record<string, unknown>; result?: string; changes?: Change[]; meta?: CompanyMeta };
}

// wall-clock timestamps (e.g. when a customer notice was sent) are not business divergence
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const noClock = (t: string) => t.replace(ISO, '<time>');
// `ord` is the row order of the projection (representation), not business data; null = absent (events recorded
// before an attribute existed, e.g. released_at of ontology 0.1.0 before M5, compare equal)
const canon = (v: unknown): string => JSON.stringify(v, (k, x) => (k === 'ord' || (k !== '' && x === null)) ? undefined : (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const companyOf = (o: Objects, meta: CompanyMeta) => new SofaCompany(objectsToWorld(o, meta));

export function verdict(c: Candidate, ir: OntologyIr, action: string, agent: string | null): 'deny' | 'require_four_eyes' | 'require_step_up' | undefined {
  if (c.disabledActions?.includes(action)) return 'deny';
  const a = ir.actions.find((x) => x.name === action);
  const classes = new Set([a?.target, ...(a?.input.filter((f) => f.rangeKind === 'class').map((f) => f.range) ?? [])].filter(Boolean) as string[]);
  let worst: 'deny' | 'require_four_eyes' | 'require_step_up' | undefined;
  for (const o of c.overlays ?? []) {
    const m = o.match ?? {};
    const hit = (!m.actions || m.actions.includes(action)) && (!m.classes || m.classes.some((x) => classes.has(x))) && (!m.agents || (!!agent && m.agents.includes(agent)));
    if (!hit || (!m.actions && !m.classes && !m.agents)) continue;
    if (o.effect === 'deny') return 'deny';
    worst = worst === 'require_step_up' ? worst : o.effect;
  }
  return worst;
}

export async function shadowReplay(pool: pg.Pool | pg.PoolClient, ir: OntologyIr, o: { windowMs?: number; fromSeq?: number; toSeq?: number; candidate?: Candidate }) {
  const candidate = o.candidate ?? {};
  const toSeq = o.toSeq ?? Number((await pool.query<{ m: string | null }>('SELECT max(seq) AS m FROM events')).rows[0]?.m ?? 0);
  let fromSeq = o.fromSeq;
  if (fromSeq === undefined) {
    const r = await pool.query<{ s: string | null }>("SELECT min(seq) AS s FROM events WHERE occurred_at >= now() - ($1::bigint * interval '1 millisecond')", [o.windowMs ?? 7 * 86_400_000]);
    fromSeq = r.rows[0]?.s ? Number(r.rows[0].s) : toSeq + 1;
  }
  // state at the start of the window: T0 + recorded changes before it
  const t0 = new SofaCompany();
  let objects = worldToObjects(t0.W);
  let meta = metaOf(t0.W, t0.seq, 0);
  const before = await pool.query<Ev>("SELECT seq, type, action, actor_agent, payload FROM events WHERE seq < $1 AND payload ? 'changes' ORDER BY seq", [fromSeq]);
  for (const e of before.rows) {
    objects = applyChanges(objects, e.payload.changes ?? []);
    if (e.payload.meta) meta = e.payload.meta;
  }
  let actualObjects = objects;
  let actualMeta = meta;
  let shadow = companyOf(objects, meta);
  const window = await pool.query<Ev>('SELECT seq, type, action, actor_agent, payload FROM events WHERE seq >= $1 AND seq <= $2 ORDER BY seq', [fromSeq, toSeq]);
  const report = { fromSeq, toSeq, events: 0, actions: 0, replayed: 0, blocked: 0, needsApproval: 0, diverged: 0, blockedActions: [] as Array<{ seq: number; action: string; agent: string | null; effect: string }>, divergedActions: [] as Array<{ seq: number; action: string; detail: string }> };
  for (const e of window.rows) {
    report.events++;
    const changes = e.payload.changes;
    const def = e.action ? ir.actions.find((a) => a.name === e.action) : undefined;
    if (def && !def.readOnly && changes && e.type !== 'ActionApprovalRequested') {
      report.actions++;
      const v = verdict(candidate, ir, def.name, e.actor_agent);
      if (v) {
        if (v === 'require_four_eyes') report.needsApproval++;
        report.blocked++;
        if (report.blockedActions.length < 50) report.blockedActions.push({ seq: Number(e.seq), action: def.name, agent: e.actor_agent, effect: v });
      } else {
        const copy = shadow.clone();
        const res = copy.call(def.name, e.payload.input ?? {});
        const shadowChanges = res.isError ? [] : diffObjects(worldToObjects(shadow.W), worldToObjects(copy.W));
        report.replayed++;
        if (res.isError || noClock(canon(shadowChanges)) !== noClock(canon(changes)) || noClock(res.text) !== noClock(String(e.payload.result ?? ''))) {
          report.diverged++;
          if (report.divergedActions.length < 50) {
            const a = new Map((changes ?? []).map((c) => [`${c.class}:${c.id}`, noClock(canon(c.after))]));
            const first = res.isError ? `shadow refused: ${res.text.slice(0, 160)}` : (shadowChanges.find((c) => a.get(`${c.class}:${c.id}`) !== noClock(canon(c.after))) ?? changes.find((c) => !shadowChanges.some((x) => x.class === c.class && x.id === c.id)));
            report.divergedActions.push({ seq: Number(e.seq), action: def.name, detail: typeof first === 'string' ? first : first ? `${first.class}:${first.id} differs` : 'answer text differs' });
          }
        }
        if (!res.isError) shadow = copy;
      }
    } else if (changes) {
      const next = applyChanges(worldToObjects(shadow.W), changes);
      shadow = companyOf(next, e.payload.meta ?? metaOf(shadow.W, shadow.seq, shadow.writes));
    }
    if (changes) {
      actualObjects = applyChanges(actualObjects, changes);
      if (e.payload.meta) actualMeta = e.payload.meta;
    }
  }
  const actualKpi = companyOf(actualObjects, actualMeta).kpi() as unknown as Record<string, unknown>;
  const shadowKpi = shadow.kpi() as unknown as Record<string, unknown>;
  const delta = Object.fromEntries(Object.keys(actualKpi).filter((k) => typeof actualKpi[k] === 'number' && typeof shadowKpi[k] === 'number').map((k) => [k, Math.round(((shadowKpi[k] as number) - (actualKpi[k] as number)) * 100) / 100]));
  const out = { ...report, kpi: { actual: actualKpi, shadow: shadowKpi, delta }, candidate: createHash('sha256').update(canon(candidate)).digest('hex').slice(0, 12) };
  return { ...out, reportHash: createHash('sha256').update(canon(out)).digest('hex').slice(0, 16) };
}
