/*
 * Core checks (D3, M10): named preconditions the enterprise core implements and the ontology switches on per action
 * (`preconditions: [due_diligence_for_high_risk_material]` on release_purchase_order). The check's logic is code shipped
 * with the core; whether it applies is decided by the ontology in force — a reviewed change. Preconditions the domain
 * package implements inside its handlers (e.g. purchase_order_open_not_released) are not listed here and run as before.
 *
 * A check reads the objects of the ontology (projection, including extension classes and attributes of newer
 * ontology versions) and returns a refusal text or undefined. Pure.
 */

type Row = Record<string, unknown>;
export type ObjectsView = Record<string, Row[]>;

export interface CheckContext {
  args: Record<string, unknown>;
  objects: ObjectsView;
}

export type CoreCheck = (c: CheckContext) => string | undefined;

/** A supplier's statement counts when it was screened against the sanctions lists. */
export const validStatement = (s: Row) => s.sanctions_checked === true;

export const CORE_CHECKS: Record<string, CoreCheck> = {
  /** Purchase orders for high-risk commodities need a valid due-diligence statement of the supplier before release. */
  due_diligence_for_high_risk_material: ({ args, objects }) => {
    const po = (objects.PurchaseOrder ?? []).find((p) => String(p.id) === String(args.poId));
    if (!po) return undefined; // unknown orders are refused by the action itself
    const material = (objects.Material ?? []).find((m) => String(m.sku) === String(po.sku));
    if (material?.commodity_risk !== 'high') return undefined;
    const ok = (objects.DueDiligenceStatement ?? []).some((s) => String(s.supplier) === String(po.supplier) && validStatement(s));
    return ok ? undefined : `${String(po.id)} needs a valid due-diligence statement of supplier ${String(po.supplier)} before release: ${String(po.sku)} is a high-risk commodity`;
  },
};

/** The core checks an action has in the ontology in force, evaluated; unknown names are the domain's own preconditions. */
export function evaluateChecks(preconditions: string[], c: CheckContext): string[] {
  return preconditions.flatMap((name) => {
    const check = CORE_CHECKS[name];
    const r = check ? check(c) : undefined;
    return r ? [r] : [];
  });
}

/**
 * Shadow replay of a precondition (D3 evidence): the releases of a window, evaluated as if the precondition had been in
 * force, with assumed attribute values (e.g. which materials are high-risk). Uses the order as it was at release time
 * (from the event) and today's statements.
 */
export function replayPrecondition(o: { precondition: string; events: Array<{ seq: number; objectId: string; order: Row | null }>; objects: ObjectsView; assume?: Record<string, Record<string, Row>> }) {
  const check = CORE_CHECKS[o.precondition];
  if (!check) throw new Error(`unknown core check ${o.precondition}`);
  const objects: ObjectsView = { ...o.objects };
  for (const [cls, byId] of Object.entries(o.assume ?? {})) {
    const id = cls === 'Material' ? 'sku' : 'id';
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
    const view = { ...objects, PurchaseOrder: [e.order] };
    const r = check({ args: { poId: e.objectId }, objects: view });
    if (r) blocked.push({ seq: e.seq, poId: e.objectId, reason: r });
  }
  const total = o.events.filter((e) => e.order).length;
  return { total, blocked: blocked.length, share: total ? Math.round((blocked.length / total) * 1000) / 10 : 0, examples: blocked.slice(0, 10) };
}
