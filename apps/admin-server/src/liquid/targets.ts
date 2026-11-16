import type { AgentEntra, AgentSpec, CreateAgentBody, GatewayLimits, SafetyRule, UpdateAgentBody, UpstreamServer } from '@cw/shared';
import { canonical } from '@cw/ontology-ir';
import type { Overlay } from '../extensions/liquidPolicy.js';
import type { ConfigTargets } from './configRepo.js';
import { SENSITIVE_HEADER, agentToFile, type AgentFile, type DesiredState } from './layout.js';

/*
 * The admin stores as reconciler targets (ADR-0046). apply() makes each store equal the desired state and reports what
 * it changed. Agents present in the repository but missing in the registry are created (fresh secrets); agents missing
 * in the repository are never deleted by the reconciler (deleting an agent stays a console action).
 */

export interface StoreDeps {
  gateway: {
    upstreams: UpstreamServer[];
    allAllowedTools: Record<string, string[]>;
    limits: GatewayLimits;
    setUpstream(u: UpstreamServer): Promise<void>;
    deleteUpstream(name: string): Promise<void>;
    setAllowedTools(agentId: string, patterns: string[]): Promise<void>;
    removeAgent(agentId: string): Promise<void>;
    setLimits(l: GatewayLimits): Promise<void>;
  };
  safety: { get(): SafetyRule[]; save(rules: SafetyRule[]): Promise<void> };
  agents: {
    list(): AgentSpec[];
    create(body: CreateAgentBody, by: string): Promise<unknown>;
    update(agentId: string, patch: UpdateAgentBody): Promise<unknown>;
    setEntra(agentId: string, entra: AgentEntra | undefined): Promise<unknown>;
  };
  policy?: { listOverlays(): Overlay[]; replaceOverlays(list: Overlay[]): Promise<void> };
  secrets(): string[];
}

const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
const sortRules = (r: SafetyRule[]) => [...r].sort((a, b) => a.id.localeCompare(b.id));

export function storeTargets(d: StoreDeps): ConfigTargets {
  return {
    current: () => ({
      upstreams: d.gateway.upstreams.map((u) => structuredClone(u)),
      allowedTools: d.gateway.allAllowedTools,
      limits: d.gateway.limits,
      safetyRules: sortRules(d.safety.get()),
      agents: d.agents
        .list()
        .map(agentToFile)
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
      overlays: d.policy?.listOverlays() ?? [],
    }),
    secrets: d.secrets,
    async apply(want: DesiredState, by: string) {
      const changes: string[] = [];
      // upstreams: literal credential headers are not in the repository; keep the ones the store has
      const have = new Map(d.gateway.upstreams.map((u) => [u.name, u]));
      for (const u of want.upstreams) {
        const cur = have.get(u.name);
        const kept = Object.fromEntries(Object.entries(cur?.headers ?? {}).filter(([h, v]) => typeof v === 'string' && SENSITIVE_HEADER.test(h) && !(h in u.headers)));
        const next = { ...u, headers: { ...u.headers, ...kept } };
        if (!cur || !same(cur, next)) {
          await d.gateway.setUpstream(next);
          changes.push(`${cur ? 'updated' : 'added'} upstream ${u.name}`);
        }
      }
      for (const name of have.keys())
        if (!want.upstreams.some((u) => u.name === name)) {
          await d.gateway.deleteUpstream(name);
          changes.push(`removed upstream ${name}`);
        }
      const tools = d.gateway.allAllowedTools;
      for (const [agent, patterns] of Object.entries(want.allowedTools))
        if (!same([...(tools[agent] ?? [])].sort(), [...patterns].sort())) {
          await d.gateway.setAllowedTools(agent, patterns);
          changes.push(`allow-list of ${agent}`);
        }
      for (const agent of Object.keys(tools))
        if (!(agent in want.allowedTools)) {
          await d.gateway.removeAgent(agent);
          changes.push(`removed allow-list of ${agent}`);
        }
      if (!same(d.gateway.limits, want.limits)) {
        await d.gateway.setLimits(want.limits);
        changes.push('gateway limits');
      }
      if (!same(sortRules(d.safety.get()), sortRules(want.safetyRules))) {
        await d.safety.save(want.safetyRules);
        changes.push('safety rules');
      }
      if (d.policy && !same(d.policy.listOverlays(), want.overlays)) {
        await d.policy.replaceOverlays(want.overlays);
        changes.push('policy overlays');
      }
      const agents = new Map(d.agents.list().map((a) => [a.agentId, agentToFile(a)]));
      for (const a of want.agents) {
        let cur: AgentFile | undefined = agents.get(a.agentId);
        if (!cur) {
          await d.agents.create({ agentId: a.agentId, displayName: a.displayName, description: a.description, gitEmail: a.gitEmail, image: a.image, model: a.model, spendLimitUsd: a.spendLimitUsd, cpus: a.resources.cpus, memoryMb: a.resources.memoryMb, start: true }, by);
          changes.push(`created agent ${a.agentId}`);
          cur = { ...a, avatarPrompt: undefined, peers: undefined, entra: undefined };
        }
        const patch: UpdateAgentBody = {};
        if (cur.displayName !== a.displayName) patch.displayName = a.displayName;
        if ((cur.description ?? '') !== (a.description ?? '')) patch.description = a.description ?? '';
        if (cur.image !== a.image) patch.image = a.image;
        if (cur.model !== a.model) patch.model = a.model;
        if (a.spendLimitUsd !== undefined && cur.spendLimitUsd !== a.spendLimitUsd) patch.spendLimitUsd = a.spendLimitUsd;
        if (cur.resources.cpus !== a.resources.cpus) patch.cpus = a.resources.cpus;
        if (cur.resources.memoryMb !== a.resources.memoryMb) patch.memoryMb = a.resources.memoryMb;
        if ((cur.avatarPrompt ?? '') !== (a.avatarPrompt ?? '') && a.avatarPrompt !== undefined) patch.avatarPrompt = a.avatarPrompt;
        if (!same([...(cur.peers ?? [])].sort(), [...(a.peers ?? [])].sort())) patch.peers = a.peers ?? [];
        if (Object.keys(patch).length) {
          await d.agents.update(a.agentId, patch);
          changes.push(`agent ${a.agentId}: ${Object.keys(patch).join(', ')}`);
        }
        if (!same(cur.entra, a.entra)) {
          await d.agents.setEntra(a.agentId, a.entra);
          changes.push(`agent ${a.agentId}: entra`);
        }
      }
      return changes;
    },
  };
}
