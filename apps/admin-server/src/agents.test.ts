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
  GATEWAY_TOKEN: 'g'.repeat(32),
});

const spec: AgentSpec = {
  agentId: 'max',
  displayName: 'Max',
  gitEmail: 'agent-max@coworking.local',
  image: 'coworking/agent:local',
  hostPort: 8101,
  model: 'gpt-5.4-mini',
  resources: { cpus: 1, memoryMb: 2048 },
  createdAt: '',
  createdBy: 'admin',
  updatedAt: '',
};

describe('AgentService.env', () => {
  const svc = new AgentService(config, {} as never, {} as never, {} as never, {} as never);
  const env = svc.env(spec, { oidcClientSecret: 'client-secret', sessionSecret: 's'.repeat(43), internalToken: 'i'.repeat(43), aiKey: 'sk-virtual' });

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
      AI_GATEWAY_BASE_URL: 'http://litellm:4000/v1',
      AI_GATEWAY_API_KEY: 'sk-virtual',
      AI_GATEWAY_MODEL: 'gpt-5.4-mini',
    });
  });

  it('passes every value as a string (container environment)', () => {
    expect(Object.values(env).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
  });

  it('derives the agent port range from configuration', () => {
    expect(config.portRange).toEqual({ from: 8101, to: 8199 });
  });
});

describe('AgentService Entra OBO (optional)', () => {
  const secrets = { oidcClientSecret: 'c', sessionSecret: 's'.repeat(43), internalToken: 'i'.repeat(43), aiKey: 'sk' };
  const entra = { enabled: true, clientId: '11111111-2222-3333-4444-555555555555', tenantId: '66666666-7777-8888-9999-000000000000', credential: { kind: 'secret' as const, secretRef: 'agent-max-entra' }, allowAgentOnly: false };
  const harness = (store?: { get: (n: string) => Promise<string> }) => {
    const deployed: Array<Record<string, string>> = [];
    const registry = { get: () => ({ spec, secrets }), put: async () => ({ spec, secrets }) };
    const runtime = { deploy: async (_s: unknown, env: Record<string, string>) => (deployed.push(env), {}) };
    return { deployed, svc: new AgentService(config, registry as never, runtime as never, {} as never, {} as never, undefined, store as never) };
  };

  it('passes nothing Entra-related when the capability is off', () => {
    const env = new AgentService(config, {} as never, {} as never, {} as never, {} as never).env(spec, secrets);
    expect(Object.keys(env).filter((k) => k.startsWith('ENTRA_'))).toEqual([]);
  });

  it('resolves the credential in the control plane and hands it over as env (never a Key Vault reference)', async () => {
    const { svc, deployed } = harness({ get: async (n) => (n === 'agent-max-entra' ? 'the-secret' : Promise.reject(new Error('nf'))) });
    await svc.setEntra('max', entra);
    expect(deployed[0]).toMatchObject({ ENTRA_ENABLED: 'true', ENTRA_CLIENT_ID: entra.clientId, ENTRA_TENANT_ID: entra.tenantId, ENTRA_CLIENT_SECRET: 'the-secret', ENTRA_ALLOW_AGENT_ONLY: 'false' });
    expect(Object.keys(deployed[0]!)).not.toContain('ENTRA_CREDENTIAL_REF');
    expect(Object.keys(deployed[0]!).some((k) => k.startsWith('KEYVAULT'))).toBe(false);
  });

  it('refuses to deploy when the credential cannot be read or no tenant is known', async () => {
    const missing = harness({ get: async () => Promise.reject(new Error('nf')) });
    await expect(missing.svc.setEntra('max', entra)).rejects.toMatchObject({ status: 409 });
    expect(missing.deployed).toEqual([]);
    const noVault = harness(undefined);
    await expect(noVault.svc.setEntra('max', entra)).rejects.toMatchObject({ status: 409 });
    await expect(noVault.svc.setEntra('max', { ...entra, tenantId: undefined })).rejects.toMatchObject({ status: 400 });
  });
});
