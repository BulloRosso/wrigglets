import type { IrAttribute, IrInput, OntologyIr } from '@cw/ontology-ir';
import { header, js, pascal } from './util.js';

/* zod schemas and TypeScript types per enum, class and action input. Links are ids (strings) of the target object. */

function scalar(range: string): string {
  switch (range) {
    case 'integer':
      return 'z.number().int()';
    case 'float':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'date':
      return 'z.iso.date()';
    case 'datetime':
      return 'z.iso.datetime({ offset: true })';
    case 'json':
      return 'z.unknown()';
    default:
      return 'z.string()';
  }
}

function zodOf(f: Pick<IrAttribute, 'range' | 'rangeKind' | 'multivalued' | 'required' | 'description'> & { enum?: string[] }, forInput: boolean): string {
  let t: string;
  if (f.enum?.length) t = `z.enum(${js(f.enum)})`;
  else if (f.rangeKind === 'enum') t = f.range;
  else if (f.rangeKind === 'class') t = 'z.string().min(1)';
  else t = scalar(f.range);
  if (f.multivalued) t = `z.array(${t})`;
  if (f.description) t += `.describe(${js(f.description)})`;
  if (!f.required) t += forInput ? '.optional()' : '.nullish()';
  return t;
}

export function genTypes(ir: OntologyIr): string {
  const out: string[] = [header(ir, '//'), "import { z } from 'zod';", ''];
  out.push(`export const ONTOLOGY = { name: ${js(ir.name)}, version: ${js(ir.version)}, hash: ${js(ir.hash)} } as const;`, '');
  for (const e of ir.enums) {
    if (e.description) out.push(`/** ${e.description} */`);
    out.push(`export const ${e.name} = z.enum(${js(e.values.map((v) => v.value))});`, `export type ${e.name} = z.infer<typeof ${e.name}>;`, '');
  }
  for (const c of ir.classes) {
    out.push(`/** ${c.description ?? c.name} (criticality: ${c.annotations.criticality}, data: ${c.annotations.data_class}, owner: ${c.annotations.owner}) */`);
    out.push(`export const ${c.name} = z.object({`);
    for (const a of c.attributes) out.push(`  ${a.name}: ${zodOf(a, false)},`);
    out.push('});', `export type ${c.name} = z.infer<typeof ${c.name}>;`, '');
  }
  out.push(`export const CLASSES = { ${ir.classes.map((c) => `${c.name}`).join(', ')} } as const;`, `export type ClassName = keyof typeof CLASSES;`, '');
  for (const a of ir.actions) {
    const name = `${pascal(a.name)}Input`;
    out.push(`/** Input of ${a.name} (${a.kind}${a.readOnly ? ', read-only' : ''}${a.destructive ? ', destructive' : ''}) */`);
    out.push(`export const ${name} = z.object({`);
    for (const f of a.input as IrInput[]) out.push(`  ${f.name}: ${zodOf(f, true)},`);
    out.push('});', `export type ${name} = z.infer<typeof ${name}>;`, '');
  }
  out.push('export const ACTION_INPUTS = {');
  for (const a of ir.actions) out.push(`  ${a.name}: ${pascal(a.name)}Input,`);
  out.push('} as const;', 'export type ActionName = keyof typeof ACTION_INPUTS;', '');
  return `${out.join('\n')}`;
}
