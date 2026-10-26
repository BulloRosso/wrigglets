import { describe, expect, it } from 'vitest';
import { agentEntra } from './controlplane.js';
import { upstreamServer } from './gateway.js';

const guid = '11111111-2222-3333-4444-555555555555';

describe('Entra OBO schemas', () => {
  it('accepts a secret credential only with a Key Vault reference', () => {
    expect(agentEntra.safeParse({ enabled: true, clientId: guid, credential: { kind: 'secret', secretRef: 'agent-max-entra' } }).success).toBe(true);
    expect(agentEntra.safeParse({ enabled: true, clientId: guid, credential: { kind: 'secret' } }).success).toBe(false);
    expect(agentEntra.safeParse({ enabled: true, clientId: guid, credential: { kind: 'federated' } }).success).toBe(true);
  });
  it('rejects malformed ids and defaults agent-only to off', () => {
    expect(agentEntra.safeParse({ enabled: true, clientId: 'nope', credential: { kind: 'federated' } }).success).toBe(false);
    expect(agentEntra.parse({ enabled: true, clientId: guid, credential: { kind: 'federated' } }).allowAgentOnly).toBe(false);
  });
  it('upstreams default to static and need a scope for obo', () => {
    const base = { name: 'crm', url: 'http://crm:8080/mcp' };
    expect(upstreamServer.parse(base)).toMatchObject({ auth: 'static', oboFallback: 'deny' });
    expect(upstreamServer.safeParse({ ...base, auth: 'obo' }).success).toBe(false);
    expect(upstreamServer.safeParse({ ...base, auth: 'obo', oboScope: 'api://x/.default' }).success).toBe(true);
  });
});
