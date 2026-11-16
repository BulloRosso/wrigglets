import type { Playbook, Trigger } from './schema.js';

/*
 * Pure helpers of the control loop: template rendering for step inputs, trigger matching on events, blast radius over
 * the ontology, and the mapping of the safety rules (ADR-0022) onto safety_metric triggers.
 */

/** "{{ a.b }}" alone → the value itself (arrays stay arrays); inside text → stringified. Unknown paths → error. */
export function render(value: unknown, ctx: Record<string, unknown>): unknown {
  const get = (p: string) => {
    let cur: unknown = ctx;
    for (const k of p.trim().split('.')) {
      if (cur === null || typeof cur !== 'object' || !(k in (cur as Record<string, unknown>))) throw new Error(`unknown template value {{ ${p.trim()} }}`);
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  };
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(value);
    if (whole) return get(whole[1]!);
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, p: string) => {
      const v = get(p);
      return Array.isArray(v) ? v.join(', ') : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => render(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, ctx)]));
  return value;
}

/** A sensed event (alert, safety metric, signal, schedule tick or any event-log event). */
export interface SensedEvent {
  kind: 'alert' | 'safety_metric' | 'signal' | 'schedule' | 'event';
  type?: string;
  /** For schedules: the playbook id the tick is for. */
  playbook?: string;
  data: Record<string, unknown>;
}

const matchValue = (want: unknown, got: unknown): boolean => {
  if (Array.isArray(want)) return want.some((w) => matchValue(w, got));
  if (Array.isArray(got)) return got.some((g) => matchValue(want, g));
  return String(want) === String(got);
};
const matchAll = (match: Record<string, unknown>, data: Record<string, unknown>) => Object.entries(match).every(([k, v]) => k in data && matchValue(v, data[k]));

export function triggers(t: Trigger, e: SensedEvent, playbookId?: string): boolean {
  if (t.kind !== e.kind) return false;
  switch (t.kind) {
    case 'alert':
    case 'signal':
      return matchAll(t.match, e.data);
    case 'safety_metric':
      return matchAll(Object.fromEntries(Object.entries(t.match).filter(([, v]) => v !== undefined)), e.data);
    case 'schedule':
      return e.playbook === playbookId;
    case 'event':
      return e.type === t.type && matchAll(t.match, e.data);
  }
}

export const matching = (playbooks: Playbook[], e: SensedEvent) => playbooks.filter((p) => triggers(p.trigger, e, p.id));

/* ------------------------------------------------------------------------------------------ blast radius */

export interface BlastInput {
  upstream: string;
  /** Tool names the gateway offers, e.g. erp__create_purchase_order. */
  tools: string[];
  /** IR actions (name, target, class-typed inputs). */
  actions: Array<{ name: string; target?: string; readOnly: boolean; input: Array<{ name: string; range: string; rangeKind: string }> }>;
  /** Running business workflows with their OntologyObjects. */
  workflows: Array<{ workflowId: string; objects: string[] }>;
}

export interface BlastRadius {
  upstream: string;
  tools: string[];
  actions: string[];
  /** Actions that write (the ones a tightening overlay targets). */
  writeActions: string[];
  classes: string[];
  objects: string[];
  workflows: string[];
}

/** upstream → tools → actions → classes → objects / running workflows (pure). */
export function blastRadius(i: BlastInput): BlastRadius {
  const tools = i.tools.filter((t) => t.startsWith(`${i.upstream}__`)).sort();
  const names = new Set(tools.map((t) => t.slice(i.upstream.length + 2)));
  const acts = i.actions.filter((a) => names.has(a.name));
  const classes = new Set<string>();
  for (const a of acts) {
    if (a.target) classes.add(a.target);
    for (const f of a.input) if (f.rangeKind === 'class') classes.add(f.range);
  }
  const wf = i.workflows.filter((w) => w.objects.some((o) => classes.has(o.split(':')[0]!)));
  const objects = new Set(wf.flatMap((w) => w.objects.filter((o) => classes.has(o.split(':')[0]!))));
  return {
    upstream: i.upstream,
    tools,
    actions: acts.map((a) => a.name).sort(),
    writeActions: acts.filter((a) => !a.readOnly).map((a) => a.name).sort(),
    classes: [...classes].sort(),
    objects: [...objects].sort(),
    workflows: wf.map((w) => w.workflowId).sort(),
  };
}

/* ------------------------------------------------------------------------------------------ safety rules */

export interface SafetyRuleLike {
  id: string;
  kind: string;
  enabled: boolean;
  threshold: number;
  windowMinutes: number;
  level: 'paused' | 'tools_off' | 'stopped';
}

/**
 * A safety rule as a playbook: the safety engine is the sensor (it emits a safety_metric event when a rule trips), the
 * playbook raises the kill switch. Same inputs → same level as the engine (tested).
 */
export function safetyRuleToPlaybook(r: SafetyRuleLike): Playbook {
  return {
    id: `safety-${r.id}`,
    version: 1,
    title: `Safety rule ${r.id}`,
    description: `${r.kind} ≥ ${r.threshold} within ${r.windowMinutes} min raises the agent's kill switch to ${r.level}.`,
    trigger: { kind: 'safety_metric', match: { rule: r.id } },
    assess: { blast_radius: 'none' },
    steps: [{ id: 'raise-kill-switch', type: 'killswitch.raise', autonomy: 'auto', with: { level: r.level, agent: '{{ trigger.agent }}', reason: `Safety rule "${r.id}"` } }],
    learn: { record_incident: true },
  };
}

/** The engine's decision for one observation (ADR-0022): trips at value ≥ threshold, raises to the rule's level. */
export function safetyDecision(r: SafetyRuleLike, value: number): { tripped: boolean; level?: SafetyRuleLike['level'] } {
  return r.enabled && value >= r.threshold ? { tripped: true, level: r.level } : { tripped: false };
}
