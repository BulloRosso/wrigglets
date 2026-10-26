import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { pino } from 'pino';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { UpstreamServer } from '@cw/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OboClient } from './oboClient.js';
import { UpstreamPool } from './upstreams.js';

/* A tiny MCP server that answers with the Authorization header it received. */
let mcp: HttpServer;
let mcpUrl: string;
const received: Array<string | undefined> = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    received.push(req.header('authorization'));
    const server = new Server({ name: 'crm', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'whoami', description: 'echo', inputSchema: { type: 'object', properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: String(req.header('authorization')) }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  mcp = createServer(app).listen(0);
  await new Promise((r) => mcp.once('listening', r));
  mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
});
afterAll(() => void mcp.close());

const upstream = (over: Partial<UpstreamServer> = {}): UpstreamServer => ({
  name: 'crm',
  url: mcpUrl,
  headers: {},
  enabled: true,
  auth: 'obo',
  oboScope: 'api://crm/.default',
  oboFallback: 'deny',
  ...over,
});
const pool = () => new UpstreamPool(undefined, pino({ level: 'silent' }));
const textOf = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;

describe('OBO upstream calls', () => {
  it('sends the caller token on exactly that call and never reuses it for the next caller', async () => {
    const p = pool();
    const u = [upstream()];
    expect(textOf(await p.call(u, 'crm__whoami', {}, 5000, 'token-alice'))).toBe('Bearer token-alice');
    expect(textOf(await p.call(u, 'crm__whoami', {}, 5000, 'token-bob'))).toBe('Bearer token-bob');
    // every request of those two calls carried only its own caller's token
    expect(received.filter((a) => a?.includes('alice')).length).toBeGreaterThan(0);
    const bobIdx = received.findIndex((a) => a === 'Bearer token-bob');
    expect(received.slice(bobIdx).some((a) => a === 'Bearer token-alice')).toBe(false);
  });

  it('refuses to call an OBO upstream without a token (no static fallback)', async () => {
    const before = received.length;
    await expect(pool().call([upstream({ headers: { Authorization: 'Bearer static-secret' } })], 'crm__whoami', {}, 5000)).rejects.toThrow(/requires an Entra token/);
    expect(received).toHaveLength(before);
  });

  it('discovers OBO tools only with a token and falls back to the last known list', async () => {
    const p = pool();
    const u = [upstream()];
    expect(await p.listTools(u, async () => undefined)).toEqual([]);
    p.invalidate();
    expect((await p.listTools(u, async () => 'agent-token')).map((t) => t.name)).toEqual(['crm__whoami']);
    p.invalidate();
    expect((await p.listTools(u, async () => undefined)).map((t) => t.name)).toEqual(['crm__whoami']);
  });
});

describe('OboClient', () => {
  const agent = { url: 'http://agent-max:8080' };
  const reply = (status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }> = []) =>
    (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

  it('asks the agent with the gateway token and returns the access token', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const c = new OboClient('gw-token', reply(200, { accessToken: 'tok', expiresAt: 9 }, seen));
    expect(await c.token(agent, { mode: 'obo', scope: 's', oid: 'u1' })).toEqual({ ok: true, accessToken: 'tok', expiresAt: 9 });
    expect(seen[0]!.url).toBe('http://agent-max:8080/internal/obo-token');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer gw-token');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ mode: 'obo', scope: 's', oid: 'u1' });
  });

  it('surfaces the refusal reason and treats network errors as a denial', async () => {
    expect(await new OboClient('t', reply(401, { code: 'no_user_assertion', message: 'sign in again' })).token(agent, { mode: 'obo', scope: 's', oid: 'u' })).toEqual({
      ok: false,
      code: 'no_user_assertion',
      message: 'sign in again',
    });
    const down = (async () => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    expect(await new OboClient('t', down).token(agent, { mode: 'agent-only', scope: 's' })).toMatchObject({ ok: false, code: 'agent_unreachable' });
  });
});
