import { canonical, type IrAction, type IrAttribute, type IrClass, type IrEnum, type OntologyIr } from './ir.js';

/*
 * Structural diff of two IRs (editor E3, proposals in M6): what a change proposal does to the ontology, per class,
 * attribute, link, enum and action. Pure and browser-safe; the review page colours the graph from it
 * (added = green, removed = red, changed = amber).
 */

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface IrChange {
  kind: ChangeKind;
  /** class | attribute | link | enum | action | event | binding | meta */
  element: 'class' | 'attribute' | 'link' | 'enum' | 'action' | 'event' | 'binding' | 'meta';
  /** e.g. "Supplier", "Supplier.rating", "Supplier.rating→Rating", "create_purchase_order", "version" */
  path: string;
  /** Class the change belongs to (for colouring nodes), if any. */
  class?: string;
  /** Changed fields for kind = changed (e.g. ["required", "annotations.criticality"]). */
  fields?: string[];
  before?: unknown;
  after?: unknown;
}

export interface IrDiff {
  changes: IrChange[];
  /** Per class: the strongest change touching it (added/removed for the class itself, else changed). */
  classes: Record<string, ChangeKind>;
  summary: Record<ChangeKind, number>;
}

const eq = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function changedFields(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ''): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    const va = a[k];
    const vb = b[k];
    if (eq(va, vb)) continue;
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va) && !Array.isArray(vb)) out.push(...changedFields(va as Record<string, unknown>, vb as Record<string, unknown>, `${prefix}${k}.`));
    else out.push(`${prefix}${k}`);
  }
  return out;
}

function byName<T>(xs: T[], key: (x: T) => string): Map<string, T> {
  return new Map(xs.map((x) => [key(x), x]));
}

function diffSet<T>(element: IrChange['element'], a: T[], b: T[], key: (x: T) => string, classOf: (x: T) => string | undefined, out: IrChange[], ignore: string[] = []) {
  const A = byName(a, key);
  const B = byName(b, key);
  for (const [k, x] of A) if (!B.has(k)) out.push({ kind: 'removed', element, path: k, class: classOf(x), before: x });
  for (const [k, y] of B) {
    const x = A.get(k);
    if (!x) out.push({ kind: 'added', element, path: k, class: classOf(y), after: y });
    else if (!eq(x, y)) {
      const fields = changedFields(x as Record<string, unknown>, y as Record<string, unknown>).filter((f) => !ignore.some((i) => f === i || f.startsWith(`${i}.`)));
      if (fields.length) out.push({ kind: 'changed', element, path: k, class: classOf(y), fields, before: x, after: y });
    }
  }
}

export function diffIr(a: OntologyIr, b: OntologyIr): IrDiff {
  const changes: IrChange[] = [];
  for (const f of ['name', 'version', 'title', 'description'] as const) if (!eq(a[f], b[f])) changes.push({ kind: 'changed', element: 'meta', path: f, fields: [f], before: a[f], after: b[f] });

  diffSet<IrClass>('class', a.classes, b.classes, (c) => c.name, (c) => c.name, changes, ['attributes']);
  // attributes of classes present on both sides (added/removed classes carry their attributes)
  const bClasses = byName(b.classes, (c) => c.name);
  for (const ca of a.classes) {
    const cb = bClasses.get(ca.name);
    if (!cb) continue;
    diffSet<IrAttribute>('attribute', ca.attributes, cb.attributes, (x) => `${ca.name}.${x.name}`, () => ca.name, changes);
  }
  diffSet('link', a.links, b.links, (l) => `${l.from}.${l.attribute}→${l.to}`, (l) => l.from, changes);
  diffSet<IrEnum>('enum', a.enums, b.enums, (e) => e.name, () => undefined, changes);
  diffSet<IrAction>('action', a.actions, b.actions, (x) => x.name, (x) => x.target, changes);
  diffSet('event', a.events, b.events, (e) => e.name, (e) => e.objectType, changes);
  diffSet('binding', a.bindings, b.bindings, (x) => x.class, (x) => x.class, changes);

  const classes: Record<string, ChangeKind> = {};
  for (const c of changes) {
    if (!c.class) continue;
    if (c.element === 'class') classes[c.class] = c.kind;
    else if (!classes[c.class]) classes[c.class] = 'changed';
  }
  const summary: Record<ChangeKind, number> = { added: 0, removed: 0, changed: 0 };
  for (const c of changes) summary[c.kind]++;
  return { changes, classes, summary };
}
