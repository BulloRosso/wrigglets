import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { SecretStore } from '@cw/secrets';
import type { UpstreamServer } from '@cw/shared';
import type { Logger } from 'pino';

export const SEP = '__';

/** The upstream a prefixed tool name (`<upstream>__<tool>`) belongs to. */
export function upstreamFor(upstreams: UpstreamServer[], tool: string): UpstreamServer | undefined {
  const idx = tool.indexOf(SEP);
  return idx < 0 ? undefined : upstreams.find((x) => x.enabled && x.name === tool.slice(0, idx));
}

/**
 * Connections to upstream MCP servers. Credentials are resolved from Key Vault per connection and
 * never leave the gateway. Tool names are exposed as `<upstream>__<tool>`.
 */
export class UpstreamPool {
  private readonly clients = new Map<string, { client: Client; fingerprint: string }>();
  private toolCache?: { at: number; tools: Tool[] };
  /** Last tool list seen per OBO upstream (tool lists do not depend on the user). */
  private readonly oboTools = new Map<string, Tool[]>();

  constructor(
    private readonly secrets: SecretStore | undefined,
    private readonly log: Logger,
  ) {}

  private async headers(u: UpstreamServer): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(u.headers)) {
      if (typeof v === 'string') out[k] = v;
      else {
        if (!this.secrets) throw new Error(`Upstream ${u.name} references secret ${v.secretRef} but no Key Vault is configured`);
        out[k] = await this.secrets.get(v.secretRef);
      }
    }
    return out;
  }

  private async client(u: UpstreamServer): Promise<Client> {
    const fingerprint = JSON.stringify([u.url, u.headers]);
    const cached = this.clients.get(u.name);
    if (cached && cached.fingerprint === fingerprint) return cached.client;
    if (cached) await cached.client.close().catch(() => undefined);
    const client = new Client({ name: 'coworking-mcp-gateway', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(u.url), { requestInit: { headers: await this.headers(u) } });
    await client.connect(transport);
    this.clients.set(u.name, { client, fingerprint });
    return client;
  }

  private drop(name: string) {
    const c = this.clients.get(name);
    this.clients.delete(name);
    void c?.client.close().catch(() => undefined);
  }

  /**
   * A connection that carries one caller's Entra token: never cached or shared, closed right after use,
   * so a token can not leak into another user's or agent's call (ADR-0032).
   */
  private async withToken<T>(u: UpstreamServer, accessToken: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'coworking-mcp-gateway', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(u.url), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * All upstream tools (prefixed), cached for 60 s. Unreachable upstreams are skipped.
   * `oboDiscovery` yields a token to list the tools of an OBO upstream (e.g. the agent-only token);
   * without one the last known list is used.
   */
  async listTools(upstreams: UpstreamServer[], oboDiscovery?: (u: UpstreamServer) => Promise<string | undefined>): Promise<Tool[]> {
    if (this.toolCache && Date.now() - this.toolCache.at < 60_000) return this.toolCache.tools;
    const tools: Tool[] = [];
    const prefix = (u: UpstreamServer, list: Tool[]) =>
      list.map((t) => ({ ...t, name: `${u.name}${SEP}${t.name}`, description: `[${u.name}] ${t.description ?? ''}`.trim() }));
    for (const u of upstreams.filter((x) => x.enabled)) {
      if (u.auth === 'obo') {
        try {
          const token = await oboDiscovery?.(u);
          if (token) this.oboTools.set(u.name, (await this.withToken(u, token, (c) => c.listTools())).tools);
        } catch (err) {
          this.log.warn({ upstream: u.name, err: String(err) }, 'OBO upstream tools could not be discovered');
        }
        tools.push(...prefix(u, this.oboTools.get(u.name) ?? []));
        continue;
      }
      try {
        const res = await (await this.client(u)).listTools();
        tools.push(...prefix(u, res.tools));
      } catch (err) {
        this.drop(u.name);
        this.log.warn({ upstream: u.name, err: String(err) }, 'upstream not reachable');
      }
    }
    this.toolCache = { at: Date.now(), tools };
    return tools;
  }

  /** Annotations the upstream declared for a (prefixed) tool, from the cached tool list. */
  async annotationsOf(upstreams: UpstreamServer[], name: string): Promise<Tool['annotations']> {
    return (await this.listTools(upstreams)).find((t) => t.name === name)?.annotations;
  }

  invalidate() {
    this.toolCache = undefined;
  }

  /** `accessToken`: Entra token for this single call; required for (and only used with) OBO upstreams. */
  async call(upstreams: UpstreamServer[], name: string, args: Record<string, unknown>, timeoutMs: number, accessToken?: string): Promise<CallToolResult> {
    const idx = name.indexOf(SEP);
    const u = upstreamFor(upstreams, name);
    if (idx < 0 || !u) throw new Error(`Unknown tool ${name}`);
    if (u.auth === 'obo') {
      if (!accessToken) throw new Error(`Upstream ${u.name} requires an Entra token`);
      return (await this.withToken(u, accessToken, (c) => c.callTool({ name: name.slice(idx + SEP.length), arguments: args }, undefined, { timeout: timeoutMs }))) as CallToolResult;
    }
    try {
      return (await (await this.client(u)).callTool({ name: name.slice(idx + SEP.length), arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult;
    } catch (err) {
      this.drop(u.name);
      throw err;
    }
  }
}
