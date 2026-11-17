import { z } from 'zod';
import YAML from 'yaml';
import { agentEntra, safetyRules, upstreamServer, type AgentSpec, type GatewayLimits, type SafetyRule, type UpstreamServer } from '@cw/shared';
import { validatePlaybook } from '@cw/playbooks';
import { overlayInput, type Overlay } from '../extensions/liquidPolicy.js';

/*
 * Layout of the config repository (ADR-0046) and the mapping between files and the desired state of the admin stores.
 * Pure: no I/O. Secrets never go into files: upstream headers are exported only as Key Vault references (literal
 * header values that look like credentials stay in /data), agent secrets are not part of an agent's file.
 *
 *   gateway/upstreams.yaml   gateway/allow-lists.yaml   gateway/limits.yaml
 *   safety/rules.yaml        agents/<id>.yaml
 *   policies/liquid/**       (Rego, roles/data.json, overlays.yaml)
 *   ontology/<domain>/{schema,actions,bindings}.yaml
 *   playbooks/*.yaml         OWNERS.yaml   README.md
 */

export const MANAGED_PREFIXES = ['gateway/', 'safety/', 'agents/', 'policies/liquid/', 'ontology/', 'playbooks/', '.forgejo/'] as const;
export const ROOT_FILES = ['OWNERS.yaml', 'README.md'] as const;
/** Files generated from the admin stores (export) — everything else is edited only through proposals. */
export const STORE_FILES = (p: string) => p.startsWith('gateway/') || p.startsWith('safety/') || p.startsWith('agents/') || p === 'policies/liquid/overlays.yaml';

export const SENSITIVE_HEADER = /authorization|token|secret|key|cookie|password|credential/i;
const AGENT_ID = /^[a-z][a-z0-9-]{2,31}$/;

export const agentFile = z
  .object({
    agentId: z.string().regex(AGENT_ID),
    displayName: z.string().trim().min(1).max(60),
    description: z.string().max(500).optional(),
    gitEmail: z.string().email(),
    image: z.string().min(1).max(300),
    model: z.string().min(3).max(120),
    spendLimitUsd: z.number().min(0.5).max(10_000).optional(),
    resources: z.object({ cpus: z.number().min(0.25).max(8), memoryMb: z.number().int().min(512).max(16_384) }).strict(),
    avatarPrompt: z.string().max(2000).optional(),
    peers: z.array(z.string().regex(AGENT_ID)).max(50).optional(),
    entra: agentEntra.optional(),
  })
  .strict();
export type AgentFile = z.infer<typeof agentFile>;

const upstreamFile = upstreamServer.superRefine((u, ctx) => {
  for (const [h, v] of Object.entries(u.headers)) if (typeof v === 'string' && SENSITIVE_HEADER.test(h)) ctx.addIssue({ code: 'custom', message: `header ${h} of upstream ${u.name}: credentials must be a Key Vault reference ({ secretRef }), never a literal`, path: ['headers', h] });
});

export const limitsFile = z.object({ callsPerMinute: z.number().int().min(1).max(10_000), maxArgBytes: z.number().int().min(1024).max(10_000_000), callTimeoutMs: z.number().int().min(1000).max(600_000) }).strict();

const ownerRef = z.string().regex(/^(role:[A-Za-z.]+|team:[a-z0-9-]+|[^@\s]+@[^@\s]+)$/, 'owner must be an e-mail, role:<Role> or team:<team>');
export const ownersFile = z
  .object({
    teams: z.record(z.string().regex(/^[a-z0-9-]+$/), z.array(ownerRef.refine((x) => !x.startsWith('team:'), 'teams cannot contain teams'))).default({}),
    rules: z.array(z.object({ path: z.string().min(1), owners: z.array(ownerRef).min(1) }).strict()).min(1),
  })
  .strict();
export type OwnersFile = z.infer<typeof ownersFile>;

export interface DesiredState {
  upstreams: UpstreamServer[];
  allowedTools: Record<string, string[]>;
  limits: GatewayLimits;
  safetyRules: SafetyRule[];
  agents: AgentFile[];
  overlays: Overlay[];
}

const yaml = (header: string, v: unknown) => `# ${header}\n${YAML.stringify(v, { sortMapEntries: true, lineWidth: 0 })}`;
const sortBy = <T>(xs: T[], k: (x: T) => string) => [...xs].sort((a, b) => k(a).localeCompare(k(b)));

export function agentToFile(a: AgentSpec): AgentFile {
  const { hostPort: _h, createdAt: _c, createdBy: _b, updatedAt: _u, ...rest } = a;
  return agentFile.parse(JSON.parse(JSON.stringify(rest)));
}

/** Store state → files (deterministic). Literal credential headers are left out (they stay in /data). */
export function exportState(s: DesiredState): Record<string, string> {
  const files: Record<string, string> = {};
  const upstreams = sortBy(s.upstreams, (u) => u.name).map((u) => ({ ...u, headers: Object.fromEntries(Object.entries(u.headers).filter(([h, v]) => typeof v !== 'string' || !SENSITIVE_HEADER.test(h))) }));
  files['gateway/upstreams.yaml'] = yaml('MCP upstreams of the gateway (ADR-0021). Credentials only as Key Vault references.', { upstreams });
  files['gateway/allow-lists.yaml'] = yaml('Tools each agent may call (patterns). A missing agent means: nothing allowed.', { allowedTools: Object.fromEntries(Object.entries(s.allowedTools).map(([k, v]) => [k, [...new Set(v)].sort()])) });
  files['gateway/limits.yaml'] = yaml('Gateway limits per agent.', s.limits);
  files['safety/rules.yaml'] = yaml('Safety rules (ADR-0022): watched by the control plane, trigger the kill switch.', { rules: sortBy(s.safetyRules, (r) => r.id) });
  for (const a of s.agents) files[`agents/${a.agentId}.yaml`] = yaml(`Agent ${a.agentId} (no secrets: they stay in the control plane).`, a);
  files['policies/liquid/overlays.yaml'] = yaml('Tightening overlays (ADR-0044). Added automatically or by admins; removing one loosens the policy and needs a person.', { overlays: sortBy(s.overlays, (o) => o.id) });
  return files;
}

export interface ParseResult {
  state?: DesiredState;
  errors: Array<{ path: string; message: string }>;
}

const parseYaml = (files: Record<string, string>, p: string, errors: ParseResult['errors']): unknown => {
  const text = files[p];
  if (text === undefined) return undefined;
  try {
    return YAML.parse(text);
  } catch (err) {
    errors.push({ path: p, message: `YAML: ${(err as Error).message.split('\n')[0]}` });
    return undefined;
  }
};

function issues(p: string, r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }, errors: ParseResult['errors']) {
  if (!r.success) for (const i of r.error!.issues) errors.push({ path: p, message: `${i.path.map(String).join('.') || '(root)'}: ${i.message}` });
}

/** Files → desired state, with every schema error (not only the first). */
export function parseState(files: Record<string, string>): ParseResult {
  const errors: ParseResult['errors'] = [];
  const up = z.object({ upstreams: z.array(upstreamFile) }).strict().safeParse(parseYaml(files, 'gateway/upstreams.yaml', errors) ?? { upstreams: [] });
  issues('gateway/upstreams.yaml', up, errors);
  const al = z.object({ allowedTools: z.record(z.string().regex(AGENT_ID), z.array(z.string().regex(/^[a-z0-9_*-]{1,100}$/)).max(100)) }).strict().safeParse(parseYaml(files, 'gateway/allow-lists.yaml', errors) ?? { allowedTools: {} });
  issues('gateway/allow-lists.yaml', al, errors);
  const li = limitsFile.safeParse(parseYaml(files, 'gateway/limits.yaml', errors));
  issues('gateway/limits.yaml', li, errors);
  const sr = z.object({ rules: safetyRules }).strict().safeParse(parseYaml(files, 'safety/rules.yaml', errors) ?? { rules: [] });
  issues('safety/rules.yaml', sr, errors);
  const ov = z.object({ overlays: z.array(overlayInput.extend({ id: z.string().regex(/^ov-\d+$/), createdAt: z.string(), createdBy: z.string() })) }).strict().safeParse(parseYaml(files, 'policies/liquid/overlays.yaml', errors) ?? { overlays: [] });
  issues('policies/liquid/overlays.yaml', ov, errors);
  const agents: AgentFile[] = [];
  for (const p of Object.keys(files).filter((f) => f.startsWith('agents/'))) {
    const m = /^agents\/([a-z][a-z0-9-]{2,31})\.yaml$/.exec(p);
    if (!m) {
      errors.push({ path: p, message: 'agent files are agents/<agent-id>.yaml' });
      continue;
    }
    const r = agentFile.safeParse(parseYaml(files, p, errors));
    issues(p, r, errors);
    if (r.success && r.data.agentId !== m[1]) errors.push({ path: p, message: `agentId ${r.data.agentId} does not match the file name` });
    else if (r.success) agents.push(r.data);
  }
  if (files['OWNERS.yaml'] !== undefined) issues('OWNERS.yaml', ownersFile.safeParse(parseYaml(files, 'OWNERS.yaml', errors)), errors);
  for (const p of Object.keys(files)) {
    if (!(ROOT_FILES as readonly string[]).includes(p) && !MANAGED_PREFIXES.some((x) => p.startsWith(x))) errors.push({ path: p, message: 'not part of the config repository layout' });
    if (p.startsWith('playbooks/') && /\.ya?ml$/.test(p)) {
      const doc = parseYaml(files, p, errors);
      // tighten-only rule and step registry (ADR-0047): an invalid playbook never reaches main
      if (doc !== undefined) for (const i of validatePlaybook(doc).issues) errors.push({ path: p, message: `${i.path}: ${i.message}` });
    }
  }
  if (errors.length || !up.success || !al.success || !li.success || !sr.success || !ov.success) return { errors };
  // normalised (order-free): files written by hand or by agents compare equal to the exported form
  const allowedTools = Object.fromEntries(Object.entries(al.data.allowedTools).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...new Set(v)].sort()]));
  return { state: { upstreams: sortBy(up.data.upstreams, (u) => u.name), allowedTools, limits: li.data, safetyRules: sortBy(sr.data.rules, (r) => r.id), agents: sortBy(agents, (a) => a.agentId), overlays: sortBy(ov.data.overlays as Overlay[], (o) => o.id) }, errors };
}

/** Secrets must never reach the repository: any known secret value in any file is an error. */
export function findSecrets(files: Record<string, string>, secrets: string[]): string[] {
  const s = secrets.filter((x) => typeof x === 'string' && x.length >= 12);
  return Object.entries(files)
    .filter(([, text]) => s.some((x) => text.includes(x)))
    .map(([p]) => p);
}

/* ---------------------------------------------------------------------------------------------- owners */

export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Owner sets a decision must satisfy: per changed path the owners of the last matching rule (CODEOWNERS style), plus
 * per touched ontology class its `owner` annotation (resolved through teams; unmapped owners fall back to the path rule).
 */
export function requiredOwners(owners: OwnersFile, paths: string[], classOwners: string[] = []): Array<{ for: string; owners: string[] }> {
  const expand = (xs: string[]) => [...new Set(xs.flatMap((x) => (x.startsWith('team:') ? (owners.teams[x.slice(5)] ?? []) : [x])))].sort();
  const sets = new Map<string, { for: string; owners: string[] }>();
  for (const p of paths) {
    const rule = [...owners.rules].reverse().find((r) => globToRegex(r.path).test(p));
    if (!rule) continue;
    const o = expand(rule.owners);
    sets.set(o.join(','), { for: sets.get(o.join(','))?.for ? `${sets.get(o.join(','))!.for}, ${p}` : p, owners: o });
  }
  for (const c of [...new Set(classOwners)]) {
    const team = owners.teams[c];
    if (!team?.length) continue;
    const o = expand(team);
    if (!sets.has(o.join(','))) sets.set(o.join(','), { for: `ontology owner ${c}`, owners: o });
  }
  return [...sets.values()];
}

export const DEFAULT_OWNERS = `# Who approves changes of the config repository (ADR-0046). Last matching rule wins (like CODEOWNERS).
# Owners: e-mail addresses, role:<app role> or team:<name>. The ontology's class annotation \`owner\` is looked up in
# teams; an owner without a team entry falls back to the path rules.
teams:
  head-of-production: [role:Platform.Admin]
  head-of-logistics: [role:Platform.Admin]
  head-of-sales: [role:Platform.Admin]
rules:
  - { path: "**", owners: [role:Platform.Admin] }
  - { path: "ontology/**", owners: [role:Platform.Admin] }
  - { path: "policies/**", owners: [role:Platform.Admin] }
`;

export const README = `# Config repository (Liquid Enterprise)

The desired state of the platform (ADR-0046). Branch \`main\` is applied by the reconciler of the control plane; changes
come from the admin console (one commit per edit) or as reviewed proposals (\`proposal/<id>\` branches).

No secrets in here: credentials are Key Vault references, agent secrets stay in the control plane.
`;
