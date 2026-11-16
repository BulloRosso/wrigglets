import type { OntologyIr } from '@cw/ontology-ir';
import type { Objects } from '@cw/sofa-domain';
import { identifierIn } from './runtime.js';
import type { PolicyHook } from './service.js';

/*
 * Object-level enforcement point (ADR-0044): data.liquid.object.decision with the objects the action touches — every
 * input field whose range is a class, resolved in the current state — and their classification from the ontology.
 * Evaluated in-process by the embedded engine (ADR-0049). Fail closed: no policy loaded, an error or no decision deny
 * the action (reads included).
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
export function touchedObjects(ir: OntologyIr, action: string, args: Record<string, unknown>, objects: Objects): TouchedObject[] {
  const a = ir.actions.find((x) => x.name === action);
  if (!a) return [];
  const out: TouchedObject[] = [];
  for (const f of a.input.filter((x) => x.rangeKind === 'class')) {
    const raw = args[f.name];
    const ids = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String);
    const cls = ir.classes.find((c) => c.name === f.range)!;
    for (const id of ids) {
      const row = (objects[f.range] ?? []).find((r) => String(r[identifierIn(ir, f.range)]) === id);
      out.push({ class: f.range, id, criticality: cls.annotations.criticality, data_class: cls.annotations.data_class, owner: cls.annotations.owner, status: row && typeof row.status === 'string' ? row.status : null });
    }
  }
  return out;
}

/** Object-level policy evaluated in-process (Rego compiled to WASM, ADR-0049). Fail closed (the engine denies when empty). */
export function wasmPolicy(engine: { decide(entry: string, input: unknown): { allow: boolean; reason: string; obligations: string[] } }): PolicyHook {
  return async ({ action, caller, args, ir, objects }) => {
    const input = { action, caller: { agent: caller.agent ?? null, user: caller.user ?? null, approved_by: caller.approvedBy ?? null, workflow: caller.workflow ?? null, task: { id: caller.task ?? null, step: caller.step ?? null } }, objects: touchedObjects(ir, action, args, objects) };
    const d = engine.decide('liquid/object/decision', input);
    return { allow: d.allow, reason: d.reason || undefined, obligations: d.obligations };
  };
}
