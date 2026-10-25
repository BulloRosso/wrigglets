import { createHash, timingSafeEqual } from 'node:crypto';
import {
  A2A_TOOL,
  atLeast,
  effectiveKillSwitch,
  toolAllowed,
  type GatewayAgentConfig,
  type GatewayConfig,
  type KillLevel,
} from '@cw/shared';

/*
 * Pure access decisions of the gateway (unit-tested). Fail-closed: without a fresh configuration
 * nothing is allowed.
 */

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function authenticateAgent(config: GatewayConfig | undefined, agentId: string, bearer: string | undefined): GatewayAgentConfig | undefined {
  if (!config || !bearer) return undefined;
  const agent = config.agents.find((a) => a.agentId === agentId);
  if (!agent) return undefined;
  const a = Buffer.from(sha256(bearer), 'hex');
  const b = Buffer.from(agent.tokenSha256, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? agent : undefined;
}

export function killLevel(config: GatewayConfig, agentId: string): { level: KillLevel; reason?: string } {
  const e = effectiveKillSwitch(config.killSwitch, agentId);
  return { level: e.level, reason: e.entry?.reason };
}

export type Decision = { allowed: true } | { allowed: false; reason: string };

/** May `agent` call `tool` right now? */
export function decideToolCall(config: GatewayConfig | undefined, stale: boolean, agent: GatewayAgentConfig, tool: string): Decision {
  if (!config || stale) return { allowed: false, reason: 'Gateway configuration is not current — tools are disabled (fail-closed).' };
  const k = killLevel(config, agent.agentId);
  if (atLeast(k.level, 'tools_off')) return { allowed: false, reason: `Tools are disabled by the kill switch (${k.level}${k.reason ? `: ${k.reason}` : ''}).` };
  if (tool === A2A_TOOL.list || tool === A2A_TOOL.send || tool === A2A_TOOL.get) {
    return agent.peers.length ? { allowed: true } : { allowed: false, reason: 'This agent is isolated: no other agents are in its discovery set.' };
  }
  return toolAllowed(agent.allowedTools, tool) ? { allowed: true } : { allowed: false, reason: `Tool ${tool} is not allowed for this agent.` };
}

/** May `caller` delegate to `peer`? */
export function decideDelegation(config: GatewayConfig, caller: GatewayAgentConfig, peerId: string, openEdges: Array<[string, string]>): Decision {
  if (!caller.peers.includes(peerId)) return { allowed: false, reason: `Agent ${peerId} is not in the discovery set of ${caller.agentId}.` };
  const peer = config.agents.find((a) => a.agentId === peerId);
  if (!peer) return { allowed: false, reason: `Agent ${peerId} is unknown.` };
  const k = killLevel(config, peerId);
  if (atLeast(k.level, 'paused')) return { allowed: false, reason: `Agent ${peerId} is currently ${k.level}.` };
  if (reachable(openEdges, peerId, caller.agentId)) {
    return { allowed: false, reason: `Delegation loop prevented: ${peerId} is already (indirectly) waiting for ${caller.agentId}.` };
  }
  return { allowed: true };
}

/** Peers that may be discovered right now (not paused/stopped). */
export function visiblePeers(config: GatewayConfig, caller: GatewayAgentConfig): GatewayAgentConfig[] {
  return config.agents.filter((a) => caller.peers.includes(a.agentId) && !atLeast(killLevel(config, a.agentId).level, 'paused'));
}

function reachable(edges: Array<[string, string]>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const [a, b] of edges) if (a === n) stack.push(b);
  }
  return false;
}
