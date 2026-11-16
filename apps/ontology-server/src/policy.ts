import type { OntologyIr } from '@cw/ontology-ir';
import { identifierAttr, worldToObjects, type SofaCompany } from '@cw/sofa-domain';
import type { PolicyHook } from './service.js';

/*
 * Object-level enforcement point (ADR-0044): data.liquid.object.decision with the objects the action touches — every
 * input field whose range is a class, resolved in the current state — and their classification from the ontology.
 * Fail closed: OPA unreachable, an error or no decision deny the action (reads included).
 */

export interface TouchedObject {
  class: string;
  id: string;
  criticality: string;
  data_class: string;
  owner: string;
  status: string | null;
}

/** The objects an action call refers to (class-typed input fields), with ontology classification and status. */
export function touchedObjects(ir: OntologyIr, action: string, args: Record<string, unknown>, company: SofaCompany): TouchedObject[] {
  const a = ir.actions.find((x) => x.name === action);
  if (!a) return [];
  const objects = worldToObjects(company.W);
  const out: TouchedObject[] = [];
  for (const f of a.input.filter((x) => x.rangeKind === 'class')) {
    const raw = args[f.name];
    const ids = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String);
    const cls = ir.classes.find((c) => c.name === f.range)!;
    for (const id of ids) {
      const row = (objects[f.range] ?? []).find((r) => String(r[identifierAttr(f.range)]) === id);
      out.push({ class: f.range, id, criticality: cls.annotations.criticality, data_class: cls.annotations.data_class, owner: cls.annotations.owner, status: row && typeof row.status === 'string' ? row.status : null });
    }
  }
  return out;
}

export function opaPolicy(ir: OntologyIr, opa: { url: string; token: string; timeoutMs?: number }, fetchImpl: typeof fetch = fetch): PolicyHook {
  return async ({ action, caller, args, company }) => {
    const input = { action, caller: { agent: caller.agent ?? null, user: caller.user ?? null, approved_by: caller.approvedBy ?? null, workflow: caller.workflow ?? null, task: { id: caller.task ?? null, step: caller.step ?? null } }, objects: touchedObjects(ir, action, args, company) };
    try {
      const res = await fetchImpl(`${opa.url.replace(/\/$/, '')}/v1/data/liquid/object/decision`, {
        method: 'POST',
        headers: { authorization: `Bearer ${opa.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(opa.timeoutMs ?? 2000),
      });
      if (res.status !== 200) return { allow: false, reason: `OPA answered HTTP ${res.status} (fail closed)` };
      const r = ((await res.json().catch(() => ({}))) as { result?: { allow?: unknown; reason?: unknown; obligations?: unknown } }).result;
      if (!r || typeof r.allow !== 'boolean') return { allow: false, reason: 'OPA returned no decision — is the policy bundle loaded? (fail closed)' };
      return { allow: r.allow, reason: typeof r.reason === 'string' ? r.reason : undefined, obligations: Array.isArray(r.obligations) ? r.obligations.map(String) : [] };
    } catch (err) {
      return { allow: false, reason: `OPA not reachable: ${String(err).slice(0, 120)} (fail closed)` };
    }
  };
}
