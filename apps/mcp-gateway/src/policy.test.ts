import { describe, expect, it } from 'vitest';
import { DEFAULT_GATEWAY_LIMITS, type GatewayConfig } from '@cw/shared';
import { authenticateAgent, decideDelegation, decideToolCall, sha256, visiblePeers } from './policy.js';

const at = '2026-10-25T00:00:00Z';
const config = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  generatedAt: at,
  killSwitch: { global: { level: 'normal', by: 'system', at }, agents: {} },
  agents: [
    { agentId: 'max', displayName: 'Max', tokenSha256: sha256('max-token'), peers: ['lara'], allowedTools: ['demo__supplier_lookup'], url: 'http://agent-max:8080' },
    { agentId: 'lara', displayName: 'Lara', tokenSha256: sha256('lara-token'), peers: [], allowedTools: ['demo__*'], url: 'http://agent-lara:8080' },
  ],
  upstreams: [],
  limits: DEFAULT_GATEWAY_LIMITS,
  ...over,
});

describe('gateway policy', () => {
  it('authenticates agents by token hash', () => {
    const c = config();
    expect(authenticateAgent(c, 'max', 'max-token')?.agentId).toBe('max');
    expect(authenticateAgent(c, 'max', 'lara-token')).toBeUndefined();
    expect(authenticateAgent(c, 'nobody', 'max-token')).toBeUndefined();
    expect(authenticateAgent(undefined, 'max', 'max-token')).toBeUndefined();
  });

  it('is fail-closed without fresh configuration', () => {
    const c = config();
    expect(decideToolCall(c, true, c.agents[0]!, 'demo__supplier_lookup').allowed).toBe(false);
    expect(decideToolCall(undefined, false, c.agents[0]!, 'demo__supplier_lookup').allowed).toBe(false);
  });

  it('applies allow-lists with wildcards', () => {
    const c = config();
    expect(decideToolCall(c, false, c.agents[0]!, 'demo__supplier_lookup').allowed).toBe(true);
    expect(decideToolCall(c, false, c.agents[0]!, 'demo__fx_rate').allowed).toBe(false);
    expect(decideToolCall(c, false, c.agents[1]!, 'demo__fx_rate').allowed).toBe(true);
  });

  it('blocks all tools at kill level tools_off and above (agent or global)', () => {
    const agentOff = config({ killSwitch: { global: { level: 'normal', by: 'x', at }, agents: { max: { level: 'tools_off', reason: 'drill', by: 'admin', at } } } });
    const d = decideToolCall(agentOff, false, agentOff.agents[0]!, 'demo__supplier_lookup');
    expect(d).toEqual({ allowed: false, reason: expect.stringContaining('drill') });
    expect(decideToolCall(agentOff, false, agentOff.agents[1]!, 'demo__fx_rate').allowed).toBe(true);
    const globalStop = config({ killSwitch: { global: { level: 'stopped', reason: 'incident', by: 'admin', at }, agents: {} } });
    expect(decideToolCall(globalStop, false, globalStop.agents[1]!, 'demo__fx_rate').allowed).toBe(false);
  });

  it('keeps agents isolated unless the discovery set allows a peer', () => {
    const c = config();
    expect(decideToolCall(c, false, c.agents[1]!, 'a2a__list_agents').allowed).toBe(false); // lara has no peers
    expect(decideToolCall(c, false, c.agents[0]!, 'a2a__list_agents').allowed).toBe(true);
    expect(decideDelegation(c, c.agents[0]!, 'lara', []).allowed).toBe(true);
    expect(decideDelegation(c, c.agents[1]!, 'max', []).allowed).toBe(false); // one-directional
  });

  it('hides paused peers and refuses delegations to them', () => {
    const c = config({ killSwitch: { global: { level: 'normal', by: 'x', at }, agents: { lara: { level: 'paused', reason: 'r', by: 'admin', at } } } });
    expect(visiblePeers(c, c.agents[0]!)).toEqual([]);
    expect(decideDelegation(c, c.agents[0]!, 'lara', []).allowed).toBe(false);
  });

  it('prevents delegation loops over open delegations', () => {
    const c = config();
    c.agents[1]!.peers = ['max'];
    // max → lara is open; lara must not delegate back to max
    expect(decideDelegation(c, c.agents[1]!, 'max', [['max', 'lara']]).allowed).toBe(false);
    expect(decideDelegation(c, c.agents[1]!, 'max', []).allowed).toBe(true);
  });
});
