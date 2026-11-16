import { diffIr, type IrChange } from './diff.js';
import type { IrAction, IrAttribute, OntologyIr } from './ir.js';

/*
 * Compatibility of two ontology versions (M8, ADR-0048): what a change does to the callers (agents, apps, workflows)
 * and to the stored data.
 *   patch  descriptions, annotations, deprecation notes
 *   minor  additive: new classes, optional attributes, actions, events, enum values, optional inputs, renames that keep
 *          the old name as an alias
 *   major  breaking: removed class/attribute/action/enum value/event, changed range or multiplicity, optional → required,
 *          new required input or attribute on an existing class, changed identifier, removed alias
 * A major change needs a migration note; the projection is then rebuilt from the events instead of altered.
 */

export type CompatLevel = 'patch' | 'minor' | 'major';
export interface CompatFinding {
  level: CompatLevel;
  path: string;
  reason: string;
}
export interface Compatibility {
  level: CompatLevel;
  findings: CompatFinding[];
  /** Suggested next version for the change (semver of the ontology). */
  suggestedVersion: string;
  /** The version in `b` is at least the suggested one. */
  versionOk: boolean;
}

const RANK: Record<CompatLevel, number> = { patch: 0, minor: 1, major: 2 };
const bump = (v: string, l: CompatLevel) => {
  const [a, b, c] = v.split('.').map(Number) as [number, number, number];
  return l === 'major' ? `${a + 1}.0.0` : l === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
};
const cmp = (x: string, y: string) => {
  const p = x.split('.').map(Number);
  const q = y.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return (p[i] ?? 0) - (q[i] ?? 0);
  return 0;
};

function attributeChange(c: IrChange, f: CompatFinding[]) {
  const a = c.before as IrAttribute;
  const b = c.after as IrAttribute;
  for (const field of c.fields ?? []) {
    if (field === 'description') f.push({ level: 'patch', path: c.path, reason: 'description changed' });
    else if (field === 'required') f.push(b.required ? { level: 'major', path: c.path, reason: 'optional → required (existing objects may lack it)' } : { level: 'minor', path: c.path, reason: 'required → optional' });
    else if (field === 'range' || field === 'rangeKind') f.push({ level: 'major', path: c.path, reason: `range ${a.range} → ${b.range}` });
    else if (field === 'multivalued') f.push({ level: 'major', path: c.path, reason: 'multiplicity changed' });
    else if (field === 'identifier') f.push({ level: 'major', path: c.path, reason: 'identifier changed' });
    else f.push({ level: 'major', path: c.path, reason: `${field} changed` });
  }
}

function actionChange(c: IrChange, f: CompatFinding[]) {
  const a = c.before as IrAction;
  const b = c.after as IrAction;
  for (const field of c.fields ?? []) {
    if (field === 'description' || field === 'deprecated' || field === 'preconditions') f.push({ level: 'patch', path: c.path, reason: `${field} changed` });
    else if (field === 'input') {
      for (const i of a.input) {
        const j = b.input.find((x) => x.name === i.name);
        if (!j) f.push({ level: 'major', path: `${c.path}.${i.name}`, reason: 'input removed' });
        else if (j.range !== i.range || j.multivalued !== i.multivalued) f.push({ level: 'major', path: `${c.path}.${i.name}`, reason: `input type ${i.range} → ${j.range}` });
        else if (j.required && !i.required) f.push({ level: 'major', path: `${c.path}.${i.name}`, reason: 'input optional → required' });
        else if (JSON.stringify(j) !== JSON.stringify(i)) f.push({ level: 'patch', path: `${c.path}.${i.name}`, reason: 'input description or enum changed' });
      }
      for (const j of b.input.filter((x) => !a.input.some((i) => i.name === x.name))) f.push({ level: j.required ? 'major' : 'minor', path: `${c.path}.${j.name}`, reason: j.required ? 'new required input' : 'new optional input' });
    } else if (field === 'aliases') {
      const removed = (a.aliases ?? []).filter((x) => !(b.aliases ?? []).includes(x));
      if (removed.length) f.push({ level: 'major', path: c.path, reason: `alias removed: ${removed.join(', ')}` });
      else f.push({ level: 'minor', path: c.path, reason: 'alias added' });
    } else if (['emits', 'startsWorkflow', 'signalsWorkflow', 'mcpGroup'].includes(field)) f.push({ level: 'minor', path: c.path, reason: `${field} changed` });
    else f.push({ level: 'major', path: c.path, reason: `${field} changed (${String((a as Record<string, unknown>)[field])} → ${String((b as Record<string, unknown>)[field])})` });
  }
}

export function compatibility(a: OntologyIr, b: OntologyIr): Compatibility {
  const d = diffIr(a, b);
  const f: CompatFinding[] = [];
  const aliasesB = new Map(b.actions.flatMap((x) => (x.aliases ?? []).map((al) => [al, x.name] as const)));
  for (const c of d.changes) {
    switch (c.element) {
      case 'meta':
        if (c.path !== 'version') f.push({ level: 'patch', path: c.path, reason: `${c.path} changed` });
        break;
      case 'class':
        if (c.kind === 'added') f.push({ level: 'minor', path: c.path, reason: 'new class' });
        else if (c.kind === 'removed') f.push({ level: 'major', path: c.path, reason: 'class removed' });
        else for (const field of c.fields ?? []) f.push(field === 'identifier' ? { level: 'major', path: c.path, reason: 'identifier changed' } : { level: 'patch', path: c.path, reason: `${field} changed` });
        break;
      case 'attribute':
        if (c.kind === 'added') {
          const at = c.after as IrAttribute;
          f.push(at.required ? { level: 'major', path: c.path, reason: 'new required attribute on an existing class' } : { level: 'minor', path: c.path, reason: 'new optional attribute' });
        } else if (c.kind === 'removed') f.push({ level: 'major', path: c.path, reason: 'attribute removed' });
        else attributeChange(c, f);
        break;
      case 'link':
        // links follow from attributes; reported there
        break;
      case 'enum': {
        if (c.kind === 'added') f.push({ level: 'minor', path: c.path, reason: 'new enum' });
        else if (c.kind === 'removed') f.push({ level: 'major', path: c.path, reason: 'enum removed' });
        else {
          const va = new Set((c.before as { values: Array<{ value: string }> }).values.map((v) => v.value));
          const vb = new Set((c.after as { values: Array<{ value: string }> }).values.map((v) => v.value));
          const removed = [...va].filter((v) => !vb.has(v));
          const added = [...vb].filter((v) => !va.has(v));
          if (removed.length) f.push({ level: 'major', path: c.path, reason: `values removed: ${removed.join(', ')}` });
          if (added.length) f.push({ level: 'minor', path: c.path, reason: `values added: ${added.join(', ')}` });
          if (!removed.length && !added.length) f.push({ level: 'patch', path: c.path, reason: 'descriptions changed' });
        }
        break;
      }
      case 'action':
        if (c.kind === 'added') f.push({ level: 'minor', path: c.path, reason: 'new action' });
        else if (c.kind === 'removed') {
          const by = aliasesB.get(c.path);
          f.push(by ? { level: 'minor', path: c.path, reason: `renamed to ${by} (old name stays as a deprecated alias)` } : { level: 'major', path: c.path, reason: 'action removed' });
        } else actionChange(c, f);
        break;
      case 'event':
        f.push(c.kind === 'removed' ? { level: 'major', path: c.path, reason: 'event removed' } : { level: c.kind === 'added' ? 'minor' : 'patch', path: c.path, reason: c.kind === 'added' ? 'new event' : 'event changed' });
        break;
      case 'binding':
        f.push({ level: 'patch', path: c.path, reason: `source binding ${c.kind}` });
        break;
    }
  }
  const level = f.reduce<CompatLevel>((m, x) => (RANK[x.level] > RANK[m] ? x.level : m), 'patch');
  const suggestedVersion = f.length ? bump(a.version, level) : a.version;
  return { level, findings: f, suggestedVersion, versionOk: !f.length || cmp(b.version, suggestedVersion) >= 0 };
}
