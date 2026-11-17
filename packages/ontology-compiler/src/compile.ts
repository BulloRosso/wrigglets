import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { canonical, conditionPaths, irCheck, pathExists, sha256, sourceHash, type OntologyIr } from '@cw/ontology-ir';

/*
 * Ontology compiler (ADR-0041, ported from Python in ADR-0053): LinkML schema + actions.yaml + bindings.yaml → IR.
 *
 * The schema is LinkML, restricted to the subset the platform uses: schema metadata, `enums` with
 * `permissible_values`, `classes` with `annotations` and inline `attributes` (range, required, multivalued,
 * identifier, description), `default_range`, and `imports: [linkml:types]`. Anything else (imports of other schemas,
 * is_a, mixins, slots/slot_usage, patterns, …) is refused with a clear error instead of being half understood.
 * Output is deterministic and byte-identical to the former Python compiler: lists keep the declared order, the IR
 * carries a content hash (canonical JSON) and the hashes of its source files.
 */

export const IR_VERSION = 1;
export const SOURCES = ['schema.yaml', 'actions.yaml', 'bindings.yaml'] as const;
const SCALARS = new Set(['string', 'integer', 'float', 'boolean', 'date', 'datetime']);
const INPUT_SCALARS = new Set([...SCALARS, 'json']);
const CRITICALITY = ['business_critical', 'normal', 'payment_critical'];
const DATA_CLASS = ['confidential', 'internal', 'public'];
const KINDS = ['command', 'create', 'delete', 'query', 'update'];
const TRANSFORMS = ['json_array', 'json_field_description'];
const NAME = /^[A-Z][A-Za-z0-9]{1,80}$/;
const ACTION = /^[a-z][a-z0-9_]{1,80}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;
const SCHEMA_KEYS = new Set(['id', 'name', 'title', 'description', 'version', 'license', 'prefixes', 'default_prefix', 'default_range', 'imports', 'enums', 'classes']);
const ENUM_KEYS = new Set(['description', 'permissible_values']);
const CLASS_KEYS = new Set(['description', 'annotations', 'attributes']);
const ATTRIBUTE_KEYS = new Set(['range', 'required', 'multivalued', 'identifier', 'description']);

export interface CompileIssue {
  path: string;
  message: string;
}

export class CompileError extends Error {
  constructor(readonly errors: CompileIssue[]) {
    super(errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
  }
}

type Doc = Record<string, unknown>;
const isMap = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v);
/** Drops undefined/null values, like the Python compiler's _clean. */
const clean = <T extends Doc>(d: T): T => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined && v !== null)) as T;
const pyList = (xs: string[]) => `[${xs.map((x) => `'${x}'`).join(', ')}]`;
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

export function compileDir(dir: string): OntologyIr {
  const texts: Record<string, string> = {};
  for (const name of SOURCES) {
    const p = path.join(dir, name);
    if (!existsSync(p)) throw new CompileError([{ path: name, message: 'file is missing' }]);
    texts[name] = readFileSync(p, 'utf8');
  }
  return compileSources(texts);
}

export function compileSources(texts: Record<string, string>): OntologyIr {
  const errors: CompileIssue[] = [];
  const err = (p: string, message: string) => void errors.push({ path: p, message });
  for (const name of SOURCES) if (typeof texts[name] !== 'string') throw new CompileError([{ path: name, message: 'file is missing' }]);

  let schema: Doc;
  try {
    const s = parse(texts['schema.yaml']!) as unknown;
    if (!isMap(s)) throw new Error('the schema is not a mapping');
    schema = s;
  } catch (e) {
    throw new CompileError([{ path: 'schema.yaml', message: `LinkML could not load the schema: ${(e as Error).message}` }]);
  }
  let actionsDoc: Doc;
  let bindingsDoc: Doc;
  try {
    actionsDoc = (parse(texts['actions.yaml']!) as Doc | null) ?? {};
    bindingsDoc = (parse(texts['bindings.yaml']!) as Doc | null) ?? {};
  } catch (e) {
    throw new CompileError([{ path: 'actions.yaml/bindings.yaml', message: `invalid YAML: ${(e as Error).message}` }]);
  }

  // ------------------------------------------------------------------ the LinkML subset
  for (const k of Object.keys(schema)) if (!SCHEMA_KEYS.has(k)) err(`schema.yaml#${k}`, `LinkML feature '${k}' is not supported by the compiler (subset: ${[...SCHEMA_KEYS].join(', ')})`);
  const imports = (schema.imports as unknown[] | undefined) ?? [];
  if (!Array.isArray(imports) || imports.some((i) => i !== 'linkml:types')) err('schema.yaml#imports', "only 'linkml:types' can be imported");
  const defaultRange = str(schema.default_range) ?? 'string';
  const schemaName = str(schema.name) ?? '';
  const version = schema.version === undefined ? undefined : String(schema.version);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) err('schema.yaml#version', 'version must be semver (x.y.z)');
  for (const [doc, name] of [[actionsDoc, 'actions.yaml'], [bindingsDoc, 'bindings.yaml']] as const) {
    if (doc.ontology !== schemaName) err(`${name}#ontology`, `must be '${schemaName}' (the schema name)`);
  }

  // ------------------------------------------------------------------ enums
  const enums: Doc[] = [];
  const enumNames = new Set<string>();
  for (const [en, e] of Object.entries((schema.enums as Doc | undefined) ?? {})) {
    const def = (isMap(e) ? e : {}) as Doc;
    for (const k of Object.keys(def)) if (!ENUM_KEYS.has(k)) err(`enums.${en}`, `LinkML feature '${k}' is not supported by the compiler`);
    if (!NAME.test(en)) err(`enums.${en}`, 'enum names are PascalCase');
    enumNames.add(en);
    const values = Object.entries((def.permissible_values as Doc | undefined) ?? {}).map(([k, v]) => clean({ value: String(k), description: str(isMap(v) ? v.description : undefined) }));
    enums.push(clean({ name: en, description: str(def.description), values }));
  }

  // ------------------------------------------------------------------ classes
  const classDefs = Object.entries((schema.classes as Doc | undefined) ?? {});
  const classNames = new Set(classDefs.map(([n]) => n));
  const classes: Doc[] = [];
  const links: Doc[] = [];
  const attrsOf = new Map<string, Map<string, Doc>>();
  for (const [cn, raw] of classDefs) {
    const c = (isMap(raw) ? raw : {}) as Doc;
    const p = `classes.${cn}`;
    for (const k of Object.keys(c)) if (!CLASS_KEYS.has(k)) err(`${p}.${k}`, `LinkML feature '${k}' is not supported by the compiler (subset: annotations, attributes)`);
    if (!NAME.test(cn)) err(p, 'class names are PascalCase');
    const ann: Record<string, string> = {};
    for (const [k, v] of Object.entries((c.annotations as Doc | undefined) ?? {})) ann[k] = String(isMap(v) && 'value' in v ? v.value : v);
    if (!CRITICALITY.includes(ann.criticality ?? '')) err(`${p}.annotations.criticality`, `one of ${pyList(CRITICALITY)}`);
    if (!DATA_CLASS.includes(ann.data_class ?? '')) err(`${p}.annotations.data_class`, `one of ${pyList(DATA_CLASS)}`);
    if (!ann.owner) err(`${p}.annotations.owner`, 'required (role that approves structural changes)');
    const attributes: Doc[] = [];
    let identifier: string | undefined;
    for (const [an, rawA] of Object.entries((c.attributes as Doc | undefined) ?? {})) {
      const s = (isMap(rawA) ? rawA : {}) as Doc;
      for (const k of Object.keys(s)) if (!ATTRIBUTE_KEYS.has(k)) err(`${p}.attributes.${an}.${k}`, `LinkML feature '${k}' is not supported by the compiler (subset: ${[...ATTRIBUTE_KEYS].join(', ')})`);
      const rng = str(s.range) ?? defaultRange;
      let kind = classNames.has(rng) ? 'class' : enumNames.has(rng) ? 'enum' : SCALARS.has(rng) ? 'type' : undefined;
      if (!kind) {
        err(`${p}.attributes.${an}.range`, `unknown range '${rng}' (types: ${pyList([...SCALARS].sort())}, or an enum/class)`);
        kind = 'type';
      }
      const isId = s.identifier === true;
      if (isId) {
        if (identifier) err(`${p}.attributes.${an}`, `second identifier (already '${identifier}')`);
        identifier = an;
      }
      const a = clean({ name: an, range: rng, rangeKind: kind, required: s.required === true || isId, multivalued: s.multivalued === true, identifier: isId, description: str(s.description) });
      attributes.push(a);
      if (kind === 'class') links.push({ from: cn, attribute: an, to: rng, required: a.required, multivalued: a.multivalued });
    }
    if (!identifier) err(p, 'needs exactly one identifier attribute');
    attrsOf.set(cn, new Map(attributes.map((a) => [String(a.name), a])));
    classes.push(
      clean({
        name: cn,
        description: str(c.description),
        identifier: identifier ?? '',
        annotations: clean({ criticality: ann.criticality, data_class: ann.data_class, owner: ann.owner, mcp_group: ann.mcp_group }),
        attributes,
      }),
    );
  }

  // ------------------------------------------------------------------ events
  const events: Doc[] = [];
  const eventNames = new Set<unknown>();
  ((actionsDoc.events as unknown[] | undefined) ?? []).forEach((e, i) => {
    const p = `actions.yaml#events[${i}]`;
    if (!isMap(e) || Object.keys(e).some((k) => !['name', 'object_type', 'description'].includes(k))) return err(p, 'allowed keys: name, object_type, description');
    if (!NAME.test(String(e.name ?? ''))) err(p, 'event names are PascalCase');
    if (!classNames.has(String(e.object_type))) err(p, `unknown object_type '${String(e.object_type)}'`);
    if (eventNames.has(e.name)) err(p, `duplicate event '${String(e.name)}'`);
    eventNames.add(e.name);
    events.push(clean({ name: e.name, objectType: e.object_type, description: str(e.description) }));
  });

  // ------------------------------------------------------------------ actions
  const actions: Doc[] = [];
  const actionNames = new Set<unknown>();
  const allowedAction = new Set(['name', 'description', 'target', 'kind', 'read_only', 'destructive', 'mcp_group', 'input', 'preconditions', 'emits', 'starts_workflow', 'signals_workflow', 'aliases', 'deprecated']);
  ((actionsDoc.actions as unknown[] | undefined) ?? []).forEach((a, i) => {
    const name = isMap(a) ? a.name : undefined;
    const p = `actions.yaml#${name ? String(name) : `actions[${i}]`}`;
    if (!isMap(a)) return err(p, 'an action is a mapping');
    for (const k of Object.keys(a)) if (!allowedAction.has(k)) err(p, `unknown key '${k}'`);
    if (!ACTION.test(String(name ?? ''))) err(p, 'action names are snake_case');
    if (actionNames.has(name)) err(p, 'duplicate action');
    actionNames.add(name);
    const kind = a.kind;
    if (!KINDS.includes(String(kind))) err(`${p}.kind`, `one of ${pyList(KINDS)}`);
    const readOnly = a.read_only === true;
    if ((kind === 'query') !== readOnly) err(p, "kind 'query' and read_only: true go together");
    if (readOnly && a.destructive) err(p, 'a read-only action cannot be destructive');
    if (a.target !== undefined && a.target !== null && !classNames.has(String(a.target))) err(`${p}.target`, `unknown class '${String(a.target)}'`);
    if (!a.description) err(`${p}.description`, 'required');
    const inputs: Doc[] = [];
    for (const [fname, rawF] of Object.entries((a.input as Doc | undefined) ?? {})) {
      const fp = `${p}.input.${fname}`;
      if (!FIELD.test(fname)) err(fp, 'field names are identifiers');
      const f = (isMap(rawF) ? rawF : {}) as Doc;
      for (const k of Object.keys(f)) if (!['range', 'required', 'multivalued', 'description', 'enum'].includes(k)) err(fp, `unknown key '${k}'`);
      const rng = str(f.range) ?? 'string';
      let k2 = classNames.has(rng) ? 'class' : enumNames.has(rng) ? 'enum' : INPUT_SCALARS.has(rng) ? 'type' : undefined;
      if (!k2) {
        err(`${fp}.range`, `unknown range '${rng}'`);
        k2 = 'type';
      }
      const en = f.enum;
      if (en !== undefined && en !== null && (!Array.isArray(en) || !en.every((x) => typeof x === 'string'))) err(`${fp}.enum`, 'a list of strings');
      inputs.push(clean({ name: fname, range: rng, rangeKind: k2, required: f.required === true, multivalued: f.multivalued === true, description: str(f.description), enum: en ?? undefined }));
    }
    const emits = ((a.emits as unknown[] | undefined) ?? []).map(String);
    for (const ev of emits) if (!eventNames.has(ev)) err(`${p}.emits`, `unknown event '${ev}'`);
    if (!readOnly && !emits.length) err(`${p}.emits`, 'a write action must emit at least one event');
    if (readOnly && emits.length) err(`${p}.emits`, 'a read-only action emits no events');
    const starts = a.starts_workflow;
    if (starts !== undefined && starts !== null && (typeof starts !== 'string' || !NAME.test(starts))) err(`${p}.starts_workflow`, 'a PascalCase workflow name');
    if (starts !== undefined && starts !== null && readOnly) err(`${p}.starts_workflow`, 'a read-only action cannot start a workflow');
    const signals = a.signals_workflow;
    if (signals !== undefined && signals !== null) {
      const ok = isMap(signals) && Object.keys(signals).sort().join(',') === 'signal,workflow' && NAME.test(String(signals.workflow)) && ACTION.test(String(signals.signal));
      if (!ok) err(`${p}.signals_workflow`, '{ workflow: PascalCase, signal: snake_case }');
    }
    let aliases = a.aliases as unknown;
    if (aliases !== undefined && aliases !== null && (!Array.isArray(aliases) || !aliases.every((x) => typeof x === 'string' && ACTION.test(x)))) {
      err(`${p}.aliases`, 'a list of snake_case former action names');
      aliases = undefined;
    }
    let deprecated = a.deprecated as unknown;
    if (deprecated !== undefined && deprecated !== null && typeof deprecated !== 'string') {
      err(`${p}.deprecated`, 'a deprecation note (text)');
      deprecated = undefined;
    }
    const pre = ((a.preconditions as unknown[] | undefined) ?? []).map(String);
    for (const x of pre) if (!ACTION.test(x)) err(`${p}.preconditions`, `precondition names are snake_case: '${x}'`);
    actions.push(
      clean({
        name,
        description: str(a.description),
        target: str(a.target),
        kind,
        readOnly,
        destructive: a.destructive === true,
        mcpGroup: str(a.mcp_group),
        input: inputs,
        preconditions: pre,
        emits,
        startsWorkflow: starts ?? undefined,
        signalsWorkflow: signals ?? undefined,
        aliases: Array.isArray(aliases) && aliases.length ? [...(aliases as string[])].sort() : undefined,
        deprecated: deprecated ?? undefined,
      }),
    );
  });

  // aliases must not collide with action names or with each other (they become tool names)
  const seenAlias = new Map<string, string>();
  const names = new Set(actions.map((x) => String(x.name)));
  for (const x of actions) {
    for (const al of (x.aliases as string[] | undefined) ?? []) {
      if (names.has(al)) err(`actions.yaml#${String(x.name)}.aliases`, `alias '${al}' is the name of an action`);
      else if (seenAlias.has(al)) err(`actions.yaml#${String(x.name)}.aliases`, `alias '${al}' is already an alias of ${seenAlias.get(al)!}`);
      seenAlias.set(al, String(x.name));
    }
  }

  // ------------------------------------------------------------------ checks (declarative preconditions, ADR-0053)
  const checks: Doc[] = [];
  const shape = { classes: classes as unknown as OntologyIr['classes'] } as OntologyIr;
  for (const [cname, raw] of Object.entries((actionsDoc.checks as Doc | undefined) ?? {})) {
    const p = `actions.yaml#checks.${cname}`;
    const parsed = irCheck.safeParse({ name: cname, ...(isMap(raw) ? raw : {}) });
    if (!parsed.success) {
      err(p, parsed.error.issues.map((i) => `${i.path.join('.') || 'check'}: ${i.message}`).join('; '));
      continue;
    }
    const c = parsed.data;
    if (!classNames.has(c.subject.class)) {
      err(`${p}.subject.class`, `unknown class '${c.subject.class}'`);
      continue;
    }
    for (const cond of [c.when, c.require].filter((x) => x !== undefined)) {
      for (const path of conditionPaths(cond!)) if (!pathExists(shape, c.subject.class, path)) err(p, `path '${path}' does not resolve from ${c.subject.class}`);
      const walk = (x: unknown): void => {
        if (!isMap(x)) return;
        if (isMap(x.exists)) {
          const cls = String(x.exists.class);
          if (!classNames.has(cls)) err(p, `exists: unknown class '${cls}'`);
          else for (const attr of Object.keys((x.exists.where as Doc | undefined) ?? {})) if (!attrsOf.get(cls)!.has(attr)) err(p, `exists: '${attr}' is not an attribute of ${cls}`);
        }
        for (const v of Object.values(x)) (Array.isArray(v) ? v : [v]).forEach(walk);
      };
      walk(cond);
    }
    for (const m of c.message.matchAll(/\{subject\.([A-Za-z0-9_.]+)\}/g)) if (!pathExists(shape, c.subject.class, m[1]!)) err(p, `message: path '${m[1]}' does not resolve from ${c.subject.class}`);
    checks.push(clean({ name: c.name, description: c.description, subject: c.subject, when: c.when, require: c.require, message: c.message }));
  }

  // ------------------------------------------------------------------ bindings
  const bindings: Doc[] = [];
  const bound = new Set<string>();
  ((bindingsDoc.bindings as unknown[] | undefined) ?? []).forEach((b, i) => {
    const cn = isMap(b) ? str(b.class) : undefined;
    const p = `bindings.yaml#${cn ?? `bindings[${i}]`}`;
    if (!isMap(b)) return err(p, 'a binding is a mapping');
    for (const k of Object.keys(b)) if (!['class', 'table', 'key', 'columns', 'transforms', 'id_template'].includes(k)) err(p, `unknown key '${k}'`);
    if (!cn || !classNames.has(cn)) return err(p, `unknown class '${String(cn)}'`);
    if (bound.has(cn)) err(p, 'class bound twice');
    bound.add(cn);
    const table = String(b.table ?? '');
    if (!/^(erp|crm)_[a-z0-9_]+$/.test(table)) err(`${p}.table`, 'raw table name like erp_suppliers / crm_orders');
    const key = Array.isArray(b.key) ? b.key : [b.key];
    const attrs = attrsOf.get(cn)!;
    const cols = (b.columns as Record<string, string> | undefined) ?? {};
    for (const attr of Object.keys(cols)) if (!attrs.has(attr)) err(`${p}.columns.${attr}`, `'${attr}' is not an attribute of ${cn}`);
    const transforms = (b.transforms as Record<string, string> | undefined) ?? {};
    for (const [attr, t] of Object.entries(transforms)) {
      if (!attrs.has(attr)) err(`${p}.transforms.${attr}`, `'${attr}' is not an attribute of ${cn}`);
      if (!TRANSFORMS.includes(t)) err(`${p}.transforms.${attr}`, `unknown transform '${t}' (known: ${pyList(TRANSFORMS)})`);
    }
    const idTemplate = b.id_template ?? undefined;
    const ident = [...attrs.values()].find((a) => a.identifier)?.name;
    const columns: Record<string, string> = {};
    for (const an of attrs.keys()) {
      if (an === ident && idTemplate) continue;
      columns[an] = cols[an] ?? an;
    }
    bindings.push(clean({ class: cn, table, key: key.map((k) => String(k)), columns, transforms: Object.keys(transforms).length ? transforms : undefined, idTemplate }));
  });

  if (errors.length) throw new CompileError(errors);

  const files = Object.fromEntries(SOURCES.map((n) => [n, sourceHash(texts[n]!)]));
  const ir: Doc = clean({
    irVersion: IR_VERSION,
    name: schemaName,
    version,
    title: str(schema.title),
    description: str(schema.description),
    source: { files, hash: sha256(canonical(files)) },
    enums,
    classes,
    links,
    events,
    actions,
    bindings,
    checks: checks.length ? checks : undefined,
  });
  ir.hash = sha256(canonical(ir));
  return ir as unknown as OntologyIr;
}

/** Pretty, stable file form of the IR (sorted keys, two spaces, trailing newline); the hash is on the canonical form. */
export function dumpsIr(ir: unknown): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return `${JSON.stringify(sort(ir), null, 2)}\n`;
}
