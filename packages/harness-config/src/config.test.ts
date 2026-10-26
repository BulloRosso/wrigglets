import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUARD_PLUGIN_SOURCE, HARNESS_HARDENING_ENV, renderAgentsMd, renderHarnessConfig } from './index.js';

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

  it('loads the exfiltration guard as a local plugin only when a path is given', () => {
    expect((renderHarnessConfig({ workspaceDir: '/home/workspace', model: 'm' }) as any).plugin).toBeUndefined();
    const withGuard = renderHarnessConfig({ workspaceDir: '/home/workspace', model: 'm', guardPluginPath: '/tmp/harness/exfiltration-guard.mjs' }) as any;
    expect(withGuard.plugin).toEqual(['file:///tmp/harness/exfiltration-guard.mjs']);
  });

  it('the guard plugin hooks tool.execute.before and fails closed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'guard-'));
    const file = path.join(dir, 'p.mjs');
    await writeFile(file, GUARD_PLUGIN_SOURCE);
    const mod = (await import(pathToFileURL(file).href)) as { ExfiltrationGuard: () => Promise<Record<string, (i: unknown, o: unknown) => Promise<void>>> };
    const hook = (await mod.ExfiltrationGuard())['tool.execute.before']!;
    const call = { sessionID: 's', callID: 'c', tool: 'gateway_mail__send' };
    delete process.env.GUARD_URL;
    await expect(hook(call, { args: {} })).rejects.toThrow(/not configured/);

    const seen: unknown[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(seen.length === 1 ? { decision: 'allow' } : { decision: 'block', message: 'nope' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      process.env.GUARD_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      process.env.GUARD_TOKEN = 'tok';
      await expect(hook(call, { args: { to: 'a@b.c' } })).resolves.toBeUndefined();
      await expect(hook(call, { args: {} })).rejects.toThrow('nope');
      expect(seen[0]).toEqual({ auth: 'Bearer tok', body: { sessionID: 's', callID: 'c', tool: 'gateway_mail__send', args: { to: 'a@b.c' } } });
      process.env.GUARD_URL = 'http://127.0.0.1:1/';
      await expect(hook(call, { args: {} })).rejects.toThrow(/unavailable/);
    } finally {
      server.close();
      delete process.env.GUARD_URL;
      delete process.env.GUARD_TOKEN;
    }
  });
});
