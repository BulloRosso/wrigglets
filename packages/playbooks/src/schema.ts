import { z } from 'zod';

/*
 * Playbooks (ADR-0047): the generalised "sense → decide → act" loop. A playbook subscribes to events (trigger), assesses
 * the blast radius, and runs steps with an autonomy tier. Every step type has a declared direction; the tighten-only
 * rule: a step that loosens must have autonomy "human" (checked here, at proposal validation, and again at run time).
 */

export const KILL_LEVELS = ['normal', 'paused', 'tools_off', 'stopped'] as const;
export type Direction = 'tighten' | 'neutral' | 'loosen';
export type Autonomy = 'auto' | 'propose' | 'human';

/** Step registry: direction and what `with` must contain (after template rendering). */
export const STEP_TYPES = {
  'gateway.upstream.disable': { direction: 'tighten', with: z.object({ upstream: z.string().min(1) }).strict() },
  'killswitch.raise': { direction: 'tighten', with: z.object({ level: z.enum(['paused', 'tools_off', 'stopped']), agent: z.string().optional(), reason: z.string().max(300).optional() }).strict() },
  'policy.overlay.add': {
    direction: 'tighten',
    with: z
      .object({
        actions_on: z.array(z.string()).optional(),
        actions: z.array(z.string()).optional(),
        classes: z.array(z.string()).optional(),
        upstreams: z.array(z.string()).optional(),
        obligation: z.enum(['deny', 'require_four_eyes', 'require_step_up']).default('require_four_eyes'),
        reason: z.string().max(300).optional(),
      })
      .strict(),
  },
  'temporal.hold': { direction: 'tighten', with: z.object({ objects: z.array(z.string()), ref: z.string().min(1), reason: z.string().max(300).optional() }).strict() },
  'entra.revoke_scope': { direction: 'tighten', with: z.object({ agent: z.string().min(1), upstream: z.string().min(1) }).strict() },
  notify: { direction: 'neutral', with: z.object({ subject: z.string().min(1).max(200), body: z.string().max(4000).optional(), to: z.array(z.string().email()).max(20).optional() }).strict() },
  'shadow.replay': { direction: 'neutral', with: z.object({ window: z.string().regex(/^\d+(m|h|d)$/).default('7d'), candidate: z.record(z.string(), z.unknown()).optional() }).strict() },
  'agent.task': { direction: 'neutral', with: z.object({ agent: z.string().min(1), prompt: z.string().max(8000).optional(), approval: z.enum(['plan', 'none']).default('plan') }).strict() },
  'config.propose': { direction: 'neutral', with: z.object({ title: z.string().min(3).max(140), reason: z.string().min(3).max(4000), changes: z.array(z.object({ path: z.string(), content: z.string().nullable() })).min(1) }).strict() },
  restore: { direction: 'loosen', with: z.object({}).strict() },
  'policy.overlay.remove': { direction: 'loosen', with: z.object({ id: z.string().optional(), source: z.string().optional() }).strict() },
  'temporal.release': { direction: 'loosen', with: z.object({ ref: z.string().min(1) }).strict() },
  'gateway.upstream.enable': { direction: 'loosen', with: z.object({ upstream: z.string().min(1) }).strict() },
  'killswitch.lower': { direction: 'loosen', with: z.object({ level: z.enum(KILL_LEVELS), agent: z.string().optional() }).strict() },
} as const satisfies Record<string, { direction: Direction; with: z.ZodType }>;
export type StepType = keyof typeof STEP_TYPES;
export const directionOf = (t: string): Direction | undefined => (STEP_TYPES as Record<string, { direction: Direction }>)[t]?.direction;

/** Event subscriptions (one sensing path): alerts, safety metrics, signals and schedules all arrive as events. */
export const trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('alert'), match: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])).default({}) }).strict(),
  z.object({ kind: z.literal('safety_metric'), match: z.object({ rule: z.union([z.string(), z.array(z.string())]).optional(), level: z.union([z.enum(KILL_LEVELS), z.array(z.enum(KILL_LEVELS))]).optional() }).strict().default({}) }).strict(),
  z.object({ kind: z.literal('signal'), match: z.record(z.string(), z.unknown()).default({}) }).strict(),
  z.object({ kind: z.literal('schedule'), every: z.string().regex(/^\d+(m|h|d)$/) }).strict(),
  z.object({ kind: z.literal('event'), type: z.string().min(1), match: z.record(z.string(), z.unknown()).default({}) }).strict(),
]);
export type Trigger = z.infer<typeof trigger>;

export const step = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/),
    type: z.string(),
    autonomy: z.enum(['auto', 'propose', 'human']),
    with: z.record(z.string(), z.unknown()).default({}),
    description: z.string().max(500).optional(),
  })
  .strict();
export type Step = z.infer<typeof step>;

export const playbook = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{2,80}$/),
    version: z.number().int().min(1),
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    trigger,
    assess: z.object({ blast_radius: z.enum(['ontology', 'none']).default('none') }).strict().default({ blast_radius: 'none' }),
    steps: z.array(step).min(1).max(30),
    learn: z.object({ record_incident: z.boolean().default(false) }).strict().default({ record_incident: false }),
  })
  .strict();
export type Playbook = z.infer<typeof playbook>;

export interface PlaybookIssue {
  path: string;
  message: string;
}

/** Schema + registry + tighten-only rule. Returns every problem, not only the first. */
export function validatePlaybook(doc: unknown): { playbook?: Playbook; issues: PlaybookIssue[] } {
  const r = playbook.safeParse(doc);
  if (!r.success) return { issues: r.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message })) };
  const issues: PlaybookIssue[] = [];
  const ids = new Set<string>();
  r.data.steps.forEach((s, i) => {
    if (ids.has(s.id)) issues.push({ path: `steps.${i}.id`, message: `duplicate step id ${s.id}` });
    ids.add(s.id);
    const def = (STEP_TYPES as Record<string, { direction: Direction; with: z.ZodType }>)[s.type];
    if (!def) return void issues.push({ path: `steps.${i}.type`, message: `unknown step type ${s.type} (known: ${Object.keys(STEP_TYPES).join(', ')})` });
    if (def.direction === 'loosen' && s.autonomy !== 'human') issues.push({ path: `steps.${i}.autonomy`, message: `${s.type} loosens and must have autonomy "human" (tighten automatically, loosen only with a person)` });
    if (def.direction === 'tighten' && s.autonomy === 'propose') issues.push({ path: `steps.${i}.autonomy`, message: `${s.type} tightens: use auto or human, propose is for neutral steps` });
    // `with` can only be checked fully after rendering; templates are strings like "{{ blast.classes }}"
    const literal = Object.fromEntries(Object.entries(s.with).filter(([, v]) => !(typeof v === 'string' && /\{\{.*\}\}/.test(v))));
    const shape = def.with as unknown as z.ZodObject<z.ZodRawShape>;
    const partial = typeof shape.partial === 'function' ? shape.partial() : shape;
    const w = partial.safeParse(literal);
    if (!w.success) for (const x of w.error.issues) issues.push({ path: `steps.${i}.with.${x.path.map(String).join('.')}`, message: x.message });
  });
  return issues.length ? { issues } : { playbook: r.data, issues };
}

/** Run-time check of one step before it executes (rendered `with`, approval for loosening). */
export function checkStep(s: Pick<Step, 'type' | 'autonomy'>, rendered: Record<string, unknown>, approvedBy?: string): { ok: true; with: Record<string, unknown> } | { ok: false; error: string } {
  const def = (STEP_TYPES as Record<string, { direction: Direction; with: z.ZodType }>)[s.type];
  if (!def) return { ok: false, error: `unknown step type ${s.type}` };
  if (def.direction === 'loosen' && (s.autonomy !== 'human' || !approvedBy)) return { ok: false, error: `${s.type} loosens: it runs only with autonomy human and a person's approval` };
  const r = def.with.safeParse(rendered);
  if (!r.success) return { ok: false, error: `${s.type}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  return { ok: true, with: r.data as Record<string, unknown> };
}

export const durationMs = (d: string): number => {
  const m = /^(\d+)(m|h|d)$/.exec(d);
  if (!m) throw new Error(`bad duration ${d}`);
  return Number(m[1]) * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
};
