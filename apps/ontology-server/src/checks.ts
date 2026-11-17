import { evaluateCheck, type OntologyIr } from '@cw/ontology-ir';

/*
 * Preconditions the ontology declares (ADR-0053; ADR-0052 had them as code). An action names checks in its
 * `preconditions`; the ones defined in the IR's `checks` are evaluated here over the ontology's objects (projection,
 * including extension classes and attributes of newer versions). Names without a definition are preconditions the
 * domain package implements inside its handlers (e.g. purchase_order_open_not_released) and run there as before.
 */

type Row = Record<string, unknown>;
export type ObjectsView = Record<string, Row[]>;

export interface CheckContext {
  args: Record<string, unknown>;
  objects: ObjectsView;
}

/** The refusals of the declared checks an action has in the ontology in force. */
export function evaluateChecks(ir: OntologyIr, preconditions: string[], c: CheckContext): string[] {
  return preconditions.flatMap((name) => {
    const check = (ir.checks ?? []).find((x) => x.name === name);
    const r = check ? evaluateCheck(ir, check, c.args, c.objects) : undefined;
    return r ? [r] : [];
  });
}

/**
 * Shadow replay of a precondition (D3 evidence): the releases of a window, evaluated as if the check had been in force,
 * with assumed attribute values (e.g. which materials are high-risk). The candidate IR carries the check (a proposal's
 * IR); the order is taken as it was at release time (from the event), the other objects as they are now.
 */
export function replayPrecondition(o: { ir: OntologyIr; precondition: string; events: Array<{ seq: number; objectId: string; order: Row | null }>; objects: ObjectsView; assume?: Record<string, Record<string, Row>> }) {
  const check = (o.ir.checks ?? []).find((x) => x.name === o.precondition);
  if (!check) throw new Error(`the ontology defines no check ${o.precondition}`);
  const objects: ObjectsView = { ...o.objects };
  for (const [cls, byId] of Object.entries(o.assume ?? {})) {
    const id = o.ir.classes.find((c) => c.name === cls)?.identifier ?? 'id';
    const rows = [...(objects[cls] ?? [])];
    for (const [key, values] of Object.entries(byId)) {
      const i = rows.findIndex((r) => String(r[id]) === key);
      if (i >= 0) rows[i] = { ...rows[i], ...values };
      else rows.push({ [id]: key, ...values });
    }
    objects[cls] = rows;
  }
  const blocked: Array<{ seq: number; poId: string; reason: string }> = [];
  for (const e of o.events) {
    if (!e.order) continue;
    const r = evaluateCheck(o.ir, check, { [check.subject.input]: e.objectId }, { ...objects, [check.subject.class]: [e.order] });
    if (r) blocked.push({ seq: e.seq, poId: e.objectId, reason: r });
  }
  const total = o.events.filter((e) => e.order).length;
  return { total, blocked: blocked.length, share: total ? Math.round((blocked.length / total) * 1000) / 10 : 0, examples: blocked.slice(0, 10) };
}
