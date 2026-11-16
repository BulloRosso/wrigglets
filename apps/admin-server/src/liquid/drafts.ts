import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML, { isMap, type Document, YAMLMap } from 'yaml';
import { z } from 'zod';

/*
 * Ontology editor drafts (E2, ADR-0042/0046): a draft is a copy of the three ontology files, forked from a revision of
 * the config repository, changed by typed operations applied with the yaml Document API (comments and order stay).
 * Validate = compile with the compiler service; submit = a config proposal (E3).
 */

const pascal = z.string().regex(/^[A-Z][A-Za-z0-9]{1,60}$/, 'PascalCase, e.g. Carrier');
const snake = z.string().regex(/^[a-z][a-z0-9_]{0,60}$/, 'snake_case, e.g. carrier_id');
const range = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,60}$/);
const annotations = z.object({ criticality: z.enum(['normal', 'business_critical', 'payment_critical']), data_class: z.enum(['public', 'internal', 'confidential']), owner: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/), mcp_group: z.string().regex(/^[a-z]{2,20}$/).optional() });

export const draftOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_class'), name: pascal, description: z.string().max(500).optional(), identifier: snake.default('id'), annotations }),
  z.object({ op: z.literal('set_class_description'), class: pascal, description: z.string().max(500) }),
  z.object({ op: z.literal('set_annotation'), class: pascal, key: z.enum(['criticality', 'data_class', 'owner', 'mcp_group']), value: z.string().min(1).max(60) }),
  z.object({ op: z.literal('add_attribute'), class: pascal, name: snake, range: range.default('string'), required: z.boolean().optional(), multivalued: z.boolean().optional(), description: z.string().max(500).optional() }),
  z.object({ op: z.literal('update_attribute'), class: pascal, name: snake, range: range.optional(), required: z.boolean().optional(), multivalued: z.boolean().optional(), description: z.string().max(500).optional() }),
  z.object({ op: z.literal('remove_attribute'), class: pascal, name: snake }),
  /** A link = an attribute whose range is another class (drawn as an edge in the editor). */
  z.object({ op: z.literal('add_link'), from: pascal, attribute: snake, to: pascal, required: z.boolean().optional(), multivalued: z.boolean().optional() }),
  z.object({ op: z.literal('add_enum'), name: pascal, values: z.array(z.string().regex(/^[A-Za-z0-9_]{1,40}$/)).min(1).max(50) }),
  z.object({ op: z.literal('add_enum_value'), enum: pascal, value: z.string().regex(/^[A-Za-z0-9_]{1,40}$/), description: z.string().max(300).optional() }),
  z.object({ op: z.literal('set_version'), version: z.string().regex(/^\d+\.\d+\.\d+$/) }),
]);
export type DraftOp = z.infer<typeof draftOp>;

export class DraftError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const flow = (doc: Document, obj: Record<string, unknown>) => {
  const n = doc.createNode(obj) as YAMLMap;
  n.flow = true;
  return n;
};
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false));

function classesOf(doc: Document): YAMLMap {
  const c = doc.get('classes');
  if (!isMap(c)) throw new DraftError(422, 'schema.yaml has no classes');
  return c;
}
function classNode(doc: Document, name: string): YAMLMap {
  const c = classesOf(doc).get(name);
  if (!isMap(c)) throw new DraftError(422, `unknown class ${name}`);
  return c;
}
function attributesOf(doc: Document, cls: string): YAMLMap {
  const c = classNode(doc, cls);
  let a = c.get('attributes');
  if (!isMap(a)) {
    a = doc.createNode({}) as YAMLMap;
    c.set('attributes', a);
  }
  return a as YAMLMap;
}

/** Applies typed operations to schema.yaml (text in, text out); comments, order and flow style are preserved. */
export function applyOps(schemaYaml: string, ops: DraftOp[]): string {
  const doc = YAML.parseDocument(schemaYaml);
  if (doc.errors.length) throw new DraftError(422, `schema.yaml: ${doc.errors[0]!.message}`);
  for (const raw of ops) {
    const op = draftOp.parse(raw);
    switch (op.op) {
      case 'add_class': {
        const classes = classesOf(doc);
        if (classes.has(op.name)) throw new DraftError(409, `class ${op.name} exists`);
        const c = doc.createNode({}) as YAMLMap;
        if (op.description) c.set('description', op.description);
        c.set('annotations', flow(doc, clean(op.annotations)));
        const attrs = doc.createNode({}) as YAMLMap;
        attrs.set(op.identifier, flow(doc, { identifier: true }));
        c.set('attributes', attrs);
        classes.set(op.name, c);
        break;
      }
      case 'set_class_description':
        classNode(doc, op.class).set('description', op.description);
        break;
      case 'set_annotation': {
        const c = classNode(doc, op.class);
        const a = c.get('annotations');
        if (!isMap(a)) c.set('annotations', flow(doc, { [op.key]: op.value }));
        else a.set(op.key, op.value);
        break;
      }
      case 'add_attribute':
      case 'add_link': {
        const cls = op.op === 'add_link' ? op.from : op.class;
        const name = op.op === 'add_link' ? op.attribute : op.name;
        const r = op.op === 'add_link' ? op.to : op.range;
        if (op.op === 'add_link') classNode(doc, op.to);
        const attrs = attributesOf(doc, cls);
        if (attrs.has(name)) throw new DraftError(409, `${cls}.${name} exists`);
        attrs.set(name, flow(doc, clean({ range: r === 'string' ? undefined : r, required: op.required, multivalued: op.multivalued, description: op.op === 'add_attribute' ? op.description : undefined })));
        break;
      }
      case 'update_attribute': {
        const attrs = attributesOf(doc, op.class);
        const cur = attrs.get(op.name);
        if (cur === undefined) throw new DraftError(422, `unknown attribute ${op.class}.${op.name}`);
        const obj = { ...((isMap(cur) ? (cur.toJSON() as Record<string, unknown>) : {}) ?? {}) };
        for (const k of ['range', 'required', 'multivalued', 'description'] as const) if (op[k] !== undefined) obj[k] = op[k];
        attrs.set(op.name, flow(doc, clean(obj)));
        break;
      }
      case 'remove_attribute': {
        const attrs = attributesOf(doc, op.class);
        const cur = attrs.get(op.name);
        if (cur === undefined) throw new DraftError(422, `unknown attribute ${op.class}.${op.name}`);
        if (isMap(cur) && cur.get('identifier') === true) throw new DraftError(422, `${op.class}.${op.name} is the identifier`);
        attrs.delete(op.name);
        break;
      }
      case 'add_enum': {
        let enums = doc.get('enums');
        if (!isMap(enums)) {
          enums = doc.createNode({});
          doc.set('enums', enums);
        }
        if ((enums as YAMLMap).has(op.name)) throw new DraftError(409, `enum ${op.name} exists`);
        const values = doc.createNode({}) as YAMLMap;
        for (const v of op.values) values.set(v, flow(doc, {}));
        (enums as YAMLMap).set(op.name, doc.createNode({ permissible_values: values }));
        break;
      }
      case 'add_enum_value': {
        const e = doc.getIn(['enums', op.enum, 'permissible_values']);
        if (!isMap(e)) throw new DraftError(422, `unknown enum ${op.enum}`);
        if (e.has(op.value)) throw new DraftError(409, `${op.enum}.${op.value} exists`);
        e.set(op.value, flow(doc, clean({ description: op.description })));
        break;
      }
      case 'set_version':
        doc.set('version', op.version);
        break;
    }
  }
  return doc.toString({ lineWidth: 0 });
}

export interface Draft {
  id: string;
  domain: string;
  base: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  ops: DraftOp[];
  files: { 'schema.yaml': string; 'actions.yaml': string; 'bindings.yaml': string };
  proposal?: string;
}

/** Drafts on disk: /data/admin/liquid/drafts/<id>.json (per person, short-lived). */
export class DraftStore {
  constructor(private readonly dir: string) {}

  private file(id: string) {
    if (!/^dr-[a-z0-9-]{4,40}$/.test(id)) throw new DraftError(400, 'bad draft id');
    return path.join(this.dir, `${id}.json`);
  }

  async create(o: { domain: string; base: string; files: Draft['files']; by: string }): Promise<Draft> {
    const d: Draft = { id: `dr-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`, domain: o.domain, base: o.base, createdBy: o.by, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ops: [], files: o.files };
    await this.save(d);
    return d;
  }

  async get(id: string): Promise<Draft> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as Draft;
    } catch (err) {
      if (err instanceof DraftError) throw err;
      throw new DraftError(404, `no draft ${id}`);
    }
  }

  async list(by?: string): Promise<Draft[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: Draft[] = [];
    for (const n of names.filter((x) => x.endsWith('.json'))) out.push(JSON.parse(await readFile(path.join(this.dir, n), 'utf8')) as Draft);
    return out.filter((d) => !by || d.createdBy === by).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(d: Draft) {
    await mkdir(this.dir, { recursive: true });
    const f = this.file(d.id);
    await writeFile(`${f}.tmp`, JSON.stringify(d, null, 2));
    await rename(`${f}.tmp`, f);
  }

  async apply(id: string, ops: DraftOp[]): Promise<Draft> {
    const d = await this.get(id);
    if (d.proposal) throw new DraftError(409, `draft ${id} was submitted as proposal ${d.proposal}`);
    const parsed = ops.map((o) => draftOp.parse(o));
    d.files = { ...d.files, 'schema.yaml': applyOps(d.files['schema.yaml'], parsed) };
    d.ops = [...d.ops, ...parsed];
    d.updatedAt = new Date().toISOString();
    await this.save(d);
    return d;
  }

  async remove(id: string) {
    await rm(this.file(id), { force: true });
  }
}
