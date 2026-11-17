import { z } from 'zod';
import type { OntologyIr } from './ir.js';

/*
 * Declarative preconditions (ADR-0053): business rules as ontology data, not code. A check looks at one subject object
 * (the object an action input names), optionally only `when` a condition holds, and `require`s a condition; otherwise
 * the action is refused with the check's message. Conditions are a small closed set — path comparisons, `exists …
 * where`, all/any/not — evaluated over the ontology's objects; paths follow links (attributes whose range is a class).
 *
 *   checks:
 *     due_diligence_for_high_risk_material:
 *       subject: { class: PurchaseOrder, input: poId }
 *       when: { path: sku.commodity_risk, equals: high }
 *       require: { exists: { class: DueDiligenceStatement, where: { supplier: { path: supplier }, sanctions_checked: { equals: true } } } }
 *       message: "{subject.id} needs a valid due-diligence statement of supplier {subject.supplier} before release: {subject.sku} is a high-risk commodity"
 *
 * An action names the check in its `preconditions` like a domain precondition.
 */

const scalar = z.union([z.string(), z.number(), z.boolean()]);
export type CheckScalar = z.infer<typeof scalar>;

export type CheckCondition =
  | { path: string; equals?: CheckScalar; in?: CheckScalar[]; present?: boolean }
  | { all: CheckCondition[] }
  | { any: CheckCondition[] }
  | { not: CheckCondition }
  | { exists: { class: string; where: Record<string, { equals?: CheckScalar; path?: string }> } };

export const checkCondition: z.ZodType<CheckCondition> = z.lazy(() =>
  z.union([
    z.object({ path: z.string().min(1), equals: scalar.optional(), in: z.array(scalar).optional(), present: z.boolean().optional() }).strict(),
    z.object({ all: z.array(checkCondition).min(1) }).strict(),
    z.object({ any: z.array(checkCondition).min(1) }).strict(),
    z.object({ not: checkCondition }).strict(),
    z.object({ exists: z.object({ class: z.string().regex(/^[A-Z][A-Za-z0-9]{1,80}$/), where: z.record(z.string(), z.object({ equals: scalar.optional(), path: z.string().min(1).optional() }).strict()) }).strict() }).strict(),
  ]),
) as z.ZodType<CheckCondition>;

export const irCheck = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/),
  description: z.string().optional(),
  subject: z.object({ class: z.string().regex(/^[A-Z][A-Za-z0-9]{1,80}$/), input: z.string().min(1) }),
  when: checkCondition.optional(),
  require: checkCondition,
  message: z.string().min(1).max(500),
});
export type IrCheck = z.infer<typeof irCheck>;

type Row = Record<string, unknown>;
export type Objects = Record<string, Row[]>;

const idOf = (ir: OntologyIr, cls: string) => ir.classes.find((c) => c.name === cls)?.identifier ?? 'id';

/** Follows a dotted path from an object of `cls`: attributes, links to other objects by their identifier. */
export function resolvePath(ir: OntologyIr, objects: Objects, cls: string, row: Row | undefined, path: string): unknown {
  let current: Row | undefined = row;
  let currentClass = cls;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (!current) return undefined;
    const value = current[parts[i]!];
    if (i === parts.length - 1) return value;
    const attr = ir.classes.find((c) => c.name === currentClass)?.attributes.find((a) => a.name === parts[i]);
    if (!attr || attr.rangeKind !== 'class') return undefined;
    const target = attr.range;
    current = (objects[target] ?? []).find((r) => String(r[idOf(ir, target)]) === String(value));
    currentClass = target;
  }
  return undefined;
}

function holds(ir: OntologyIr, objects: Objects, cls: string, subject: Row, c: CheckCondition): boolean {
  if ('all' in c) return c.all.every((x) => holds(ir, objects, cls, subject, x));
  if ('any' in c) return c.any.some((x) => holds(ir, objects, cls, subject, x));
  if ('not' in c) return !holds(ir, objects, cls, subject, c.not);
  if ('exists' in c) {
    return (objects[c.exists.class] ?? []).some((r) =>
      Object.entries(c.exists.where).every(([attr, w]) => {
        const want = w.path !== undefined ? resolvePath(ir, objects, cls, subject, w.path) : w.equals;
        return want !== undefined && want !== null && String(r[attr]) === String(want);
      }),
    );
  }
  const v = resolvePath(ir, objects, cls, subject, c.path);
  if (c.present !== undefined && (v !== undefined && v !== null) !== c.present) return false;
  if (c.equals !== undefined && v !== c.equals && String(v) !== String(c.equals)) return false;
  if (c.in && !c.in.some((x) => x === v || String(x) === String(v))) return false;
  return true;
}

/** The refusal text of a check for an action call, or undefined when it passes (or does not apply). */
export function evaluateCheck(ir: OntologyIr, check: IrCheck, args: Record<string, unknown>, objects: Objects): string | undefined {
  const key = args[check.subject.input];
  if (key === undefined || key === null) return undefined; // the action's own validation reports a missing input
  const subject = (objects[check.subject.class] ?? []).find((r) => String(r[idOf(ir, check.subject.class)]) === String(key));
  if (!subject) return undefined; // unknown objects are refused by the action itself
  if (check.when && !holds(ir, objects, check.subject.class, subject, check.when)) return undefined;
  if (holds(ir, objects, check.subject.class, subject, check.require)) return undefined;
  return check.message.replace(/\{subject\.([A-Za-z0-9_.]+)\}/g, (_m, p: string) => String(resolvePath(ir, objects, check.subject.class, subject, p) ?? ''));
}

/** Paths of a condition (for validation by the compiler). */
export function conditionPaths(c: CheckCondition): string[] {
  if ('all' in c) return c.all.flatMap(conditionPaths);
  if ('any' in c) return c.any.flatMap(conditionPaths);
  if ('not' in c) return conditionPaths(c.not);
  if ('exists' in c) return Object.values(c.exists.where).flatMap((w) => (w.path ? [w.path] : []));
  return [c.path];
}

/** Does `path` resolve through the IR from `cls`? (attributes, links) */
export function pathExists(ir: OntologyIr, cls: string, path: string): boolean {
  let current = cls;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    const attr = ir.classes.find((c) => c.name === current)?.attributes.find((a) => a.name === parts[i]);
    if (!attr) return false;
    if (i < parts.length - 1) {
      if (attr.rangeKind !== 'class') return false;
      current = attr.range;
    }
  }
  return true;
}
