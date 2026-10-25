import { describe, expect, it } from 'vitest';
import { HARNESS_HARDENING_ENV, renderAgentsMd, renderHarnessConfig } from './index.js';

describe('renderHarnessConfig', () => {
  const cfg = renderHarnessConfig({ workspaceDir: '/home/workspace/', model: 'aigateway/gpt-x', smallModel: 'mini' }) as any;

  it('uses only the AI gateway provider with env substitution', () => {
    expect(cfg.enabled_providers).toEqual(['aigateway']);
    expect(cfg.provider.aigateway.options).toEqual({ baseURL: '{env:AI_GATEWAY_BASE_URL}', apiKey: '{env:AI_GATEWAY_API_KEY}' });
    expect(Object.keys(cfg.provider.aigateway.models)).toEqual(['gpt-x', 'mini']);
    expect(cfg.model).toBe('aigateway/gpt-x');
    expect(cfg.small_model).toBe('aigateway/mini');
  });

  it('puts the bash catch-all deny FIRST (opencode: last matching rule wins)', () => {
    const keys = Object.keys(cfg.permission.bash);
    expect(keys[0]).toBe('*');
    expect(cfg.permission.bash['*']).toBe('deny');
    expect(cfg.permission.bash['git status*']).toBe('allow');
    expect(cfg.permission.bash['python3 /home/workspace/scripts/*']).toBe('allow');
  });

  it('never asks (headless) and denies network and commits', () => {
    const flat = JSON.stringify(cfg.permission);
    expect(flat).not.toContain('"ask"');
    for (const k of ['webfetch', 'websearch', 'question', 'doom_loop', 'task', 'external_directory']) expect(cfg.permission[k]).toBe('deny');
    expect(Object.keys(cfg.permission.bash).some((k) => /git (commit|reset|push)/.test(k))).toBe(false);
  });

  it('references AGENTS.md explicitly (project config is disabled)', () => {
    expect(cfg.instructions).toEqual(['/home/workspace/AGENTS.md']);
    expect(HARNESS_HARDENING_ENV.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
  });

  it('renders standing instructions', () => {
    const md = renderAgentsMd({ agentId: 'max', displayName: 'Max' });
    expect(md).toContain('Never commit');
    expect(md).toContain('.agent/plans/<taskId>.md');
  });
});

describe('renderHarnessConfig with MCP gateway', () => {
  it('adds exactly one remote MCP server (the gateway) with the token from the environment', () => {
    const cfg = renderHarnessConfig({ workspaceDir: '/home/workspace', model: 'x', mcpGatewayUrl: 'http://mcp-gateway:7400/agents/max/mcp' }) as any;
    expect(Object.keys(cfg.mcp)).toEqual(['gateway']);
    expect(cfg.mcp.gateway).toMatchObject({ type: 'remote', url: 'http://mcp-gateway:7400/agents/max/mcp', oauth: false, headers: { Authorization: 'Bearer {env:MCP_GATEWAY_TOKEN}' } });
  });
  it('has no MCP block without a gateway', () => {
    expect((renderHarnessConfig({ workspaceDir: '/w', model: 'x' }) as any).mcp).toBeUndefined();
  });
});
