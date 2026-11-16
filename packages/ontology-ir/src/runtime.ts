import { z } from 'zod';
import type { IrAction, IrInput, OntologyIr } from './ir.js';

/*
 * The ontology interpreted at runtime (M8, ADR-0048): input validation of an action built from the IR when it is
 * needed, with the same rules the generated schemas had (so a new ontology version is new data, not new code).
 * Aliases resolve to their action.
 */

function scalar(range: string): z.ZodType {
  switch (range) {
    case 'integer':
      return z.number().int();
    case 'float':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.iso.date();
    case 'datetime':
      return z.iso.datetime({ offset: true });
    case 'json':
      return z.unknown();
    default:
      return z.string();
  }
}

function fieldSchema(ir: OntologyIr, f: IrInput): z.ZodType {
  let t: z.ZodType;
  if (f.enum?.length) t = z.enum(f.enum as [string, ...string[]]);
  else if (f.rangeKind === 'enum') t = z.enum(ir.enums.find((e) => e.name === f.range)!.values.map((v) => v.value) as [string, ...string[]]);
  else if (f.rangeKind === 'class') t = z.string().min(1);
  else t = scalar(f.range);
  if (f.multivalued) t = z.array(t);
  return f.required ? t : t.optional();
}

const cache = new WeakMap<OntologyIr, Map<string, z.ZodType>>();

/** zod schema of an action's input (cached per IR object). */
export function inputValidator(ir: OntologyIr, action: string): z.ZodType | undefined {
  const a = resolveAction(ir, action)?.action;
  if (!a) return undefined;
  let m = cache.get(ir);
  if (!m) cache.set(ir, (m = new Map()));
  let s = m.get(a.name);
  if (!s) m.set(a.name, (s = z.object(Object.fromEntries(a.input.map((f) => [f.name, fieldSchema(ir, f)])))));
  return s;
}

/** An action by name or by one of its aliases. */
export function resolveAction(ir: OntologyIr, name: string): { action: IrAction; viaAlias?: string } | undefined {
  const a = ir.actions.find((x) => x.name === name);
  if (a) return { action: a };
  const b = ir.actions.find((x) => x.aliases?.includes(name));
  return b ? { action: b, viaAlias: name } : undefined;
}
