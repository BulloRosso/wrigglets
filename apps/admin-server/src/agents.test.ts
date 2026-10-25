import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '@cw/shared';
import { AgentService } from './agents.js';
import { loadConfig } from './config.js';

const config = loadConfig({
  PAYLOAD_CODEC_KEYS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  OAUTH_ISSUER: 'http://localhost:9000',
  OAUTH_ADMIN_TOKEN: 'x'.repeat(32),
  ADMIN_CLIENT_SECRET: 'y'.repeat(20),
  SESSION_SECRET: 'z'.repeat(40),
  AI_GATEWAY_BASE_URL: 'http://mock-llm:4010/v1',
  AI_GATEWAY_API_KEY: 'key',
  GATEWAY_TOKEN: 'g'.repeat(32),
});

const spec: AgentSpec = {
  agentId: 'max',
  displayName: 'Max',
  gitEmail: 'agent-max@coworking.local',
  image: 'coworking/agent:local',
  hostPort: 8101,
  model: 'mock-large',
  resources: { cpus: 1, memoryMb: 2048 },
  createdAt: '',
  createdBy: 'admin',
  updatedAt: '',
};

describe('AgentService.env', () => {
  const svc = new AgentService(config, {} as never, {} as never, {} as never, {} as never);
  const env = svc.env(spec, { oidcClientSecret: 'client-secret', sessionSecret: 's'.repeat(43), internalToken: 'i'.repeat(43) });

  it('wires the agent to Temporal, the OAuth server and the model provider', () => {
    expect(env).toMatchObject({
      AGENT_ID: 'max',
      PUBLIC_BASE_URL: 'http://localhost:8101',
      TEMPORAL_ADDRESS: 'temporal:7233',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'http://localhost:9000',
      OIDC_INTERNAL_URL: 'http://oauth:9000',
      OIDC_CLIENT_ID: 'agent-max',
      OIDC_CLIENT_SECRET: 'client-secret',
      AI_GATEWAY_MODEL: 'mock-large',
    });
  });

  it('passes every value as a string (container environment)', () => {
    expect(Object.values(env).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
  });

  it('derives the agent port range from configuration', () => {
    expect(config.portRange).toEqual({ from: 8101, to: 8199 });
  });
});
