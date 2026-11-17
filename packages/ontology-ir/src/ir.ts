import { z } from 'zod';
import { irCheck } from './checks.js';

/*
 * The ontology IR (ADR-0041): a normalised JSON document produced by @cw/ontology-compiler from the LinkML schema,
 * actions.yaml and bindings.yaml. Every generator reads ONLY the IR. This schema must accept exactly what the compiler
 * writes; `verifyIr` re-computes the content hash with the same canonical form as the Python side.
 */

const pascal = z.string().regex(/^[A-Z][A-Za-z0-9]{1,80}$/);
const snake = z.string().regex(/^[a-z][a-z0-9_]{1,80}$/);
const attrName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,80}$/);

export const SCALAR_TYPES = ['string', 'integer', 'float', 'boolean', 'date', 'datetime'] as const;
export const INPUT_TYPES = [...SCALAR_TYPES, 'json'] as const;
export type ScalarType = (typeof SCALAR_TYPES)[number];

export const irAttribute = z.object({
  name: attrName,
  range: z.string().min(1),
  rangeKind: z.enum(['type', 'enum', 'class']),
  required: z.boolean(),
  multivalued: z.boolean(),
  identifier: z.boolean(),
  description: z.string().optional(),
});

export const irClass = z.object({
  name: pascal,
  description: z.string().optional(),
  identifier: attrName,
  annotations: z.object({
    criticality: z.enum(['normal', 'business_critical', 'payment_critical']),
    data_class: z.enum(['public', 'internal', 'confidential']),
    owner: z.string().min(1),
    mcp_group: z.string().optional(),
  }),
  attributes: z.array(irAttribute).min(1),
});

export const irEnum = z.object({
  name: pascal,
  description: z.string().optional(),
  values: z.array(z.object({ value: z.string().min(1), description: z.string().optional() })).min(1),
});

export const irLink = z.object({ from: pascal, attribute: attrName, to: pascal, required: z.boolean(), multivalued: z.boolean() });

export const irEvent = z.object({ name: pascal, objectType: pascal, description: z.string().optional() });

export const irInput = z.object({
  name: attrName,
  range: z.string().min(1),
  rangeKind: z.enum(['type', 'enum', 'class']),
  required: z.boolean(),
  multivalued: z.boolean(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

export const irAction = z.object({
  name: snake,
  description: z.string().min(1),
  target: pascal.optional(),
  kind: z.enum(['query', 'create', 'update', 'delete', 'command']),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  mcpGroup: z.string().optional(),
  input: z.array(irInput),
  preconditions: z.array(snake),
  emits: z.array(pascal),
  /** Business workflow started when the action's event is committed (M5). */
  startsWorkflow: pascal.optional(),
  /** Signal sent to the running workflow of the action's object (M5). */
  signalsWorkflow: z.object({ workflow: pascal, signal: snake }).optional(),
  /** Former names still served as deprecated tools (renames without breaking callers, M8). */
  aliases: z.array(snake).optional(),
  /** Deprecation note: the action still works, tools say so; removal is a breaking change later. */
  deprecated: z.string().optional(),
});

export const irBinding = z.object({
  class: pascal,
  table: z.string().regex(/^(erp|crm)_[a-z0-9_]+$/),
  key: z.array(z.string().min(1)).min(1),
  columns: z.record(z.string(), z.string()),
  transforms: z.record(z.string(), z.string()).optional(),
  idTemplate: z.string().optional(),
});

export const ontologyIr = z
  .object({
    irVersion: z.literal(1),
    name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string().optional(),
    description: z.string().optional(),
    source: z.object({ files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
    enums: z.array(irEnum),
    classes: z.array(irClass).min(1),
    links: z.array(irLink),
    events: z.array(irEvent),
    actions: z.array(irAction),
    bindings: z.array(irBinding),
    /** Declarative preconditions (ADR-0053); actions name them in `preconditions`. Absent when there are none. */
    checks: z.array(irCheck).optional(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .superRefine((ir, ctx) => {
    const classes = new Set(ir.classes.map((c) => c.name));
    const enums = new Set(ir.enums.map((e) => e.name));
    const events = new Set(ir.events.map((e) => e.name));
    for (const c of ir.classes) {
      for (const a of c.attributes) {
        if (a.rangeKind === 'class' && !classes.has(a.range)) ctx.addIssue({ code: 'custom', message: `${c.name}.${a.name}: unknown class ${a.range}` });
        if (a.rangeKind === 'enum' && !enums.has(a.range)) ctx.addIssue({ code: 'custom', message: `${c.name}.${a.name}: unknown enum ${a.range}` });
        if (a.rangeKind === 'type' && !(SCALAR_TYPES as readonly string[]).includes(a.range)) ctx.addIssue({ code: 'custom', message: `${c.name}.${a.name}: unknown type ${a.range}` });
      }
    }
    for (const a of ir.actions) {
      if (a.target && !classes.has(a.target)) ctx.addIssue({ code: 'custom', message: `${a.name}: unknown target ${a.target}` });
      for (const e of a.emits) if (!events.has(e)) ctx.addIssue({ code: 'custom', message: `${a.name}: unknown event ${e}` });
      for (const f of a.input) {
        if (f.rangeKind === 'class' && !classes.has(f.range)) ctx.addIssue({ code: 'custom', message: `${a.name}.${f.name}: unknown class ${f.range}` });
        if (f.rangeKind === 'enum' && !enums.has(f.range)) ctx.addIssue({ code: 'custom', message: `${a.name}.${f.name}: unknown enum ${f.range}` });
      }
    }
    for (const b of ir.bindings) if (!classes.has(b.class)) ctx.addIssue({ code: 'custom', message: `binding: unknown class ${b.class}` });
    for (const c of ir.checks ?? []) if (!classes.has(c.subject.class)) ctx.addIssue({ code: 'custom', message: `check ${c.name}: unknown class ${c.subject.class}` });
  });

export type OntologyIr = z.infer<typeof ontologyIr>;
export type IrClass = z.infer<typeof irClass>;
export type IrAttribute = z.infer<typeof irAttribute>;
export type IrEnum = z.infer<typeof irEnum>;
export type IrAction = z.infer<typeof irAction>;
export type IrInput = z.infer<typeof irInput>;
export type IrBinding = z.infer<typeof irBinding>;
export type IrLink = z.infer<typeof irLink>;
export type IrEvent = z.infer<typeof irEvent>;

/** Canonical JSON: sorted keys, no whitespace, UTF-8 kept. Same bytes as json.dumps(sort_keys, separators, ensure_ascii=False). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/* ----------------------------------------------------------------------------------------- lookup helpers */

export const classOf = (ir: OntologyIr, name: string) => ir.classes.find((c) => c.name === name);
export const enumOf = (ir: OntologyIr, name: string) => ir.enums.find((e) => e.name === name);
export const bindingOf = (ir: OntologyIr, name: string) => ir.bindings.find((b) => b.class === name);
export const identifierOf = (c: IrClass) => c.attributes.find((a) => a.identifier)!;
