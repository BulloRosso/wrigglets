import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { SecretStore } from '@cw/secrets';
import type { UpstreamServer } from '@cw/shared';
import type { Logger } from 'pino';

export const SEP = '__';

/**
 * Connections to upstream MCP servers. Credentials are resolved from Key Vault per connection and
 * never leave the gateway. Tool names are exposed as `<upstream>__<tool>`.
 */
export class UpstreamPool {
  private readonly clients = new Map<string, { client: Client; fingerprint: string }>();
  private toolCache?: { at: number; tools: Tool[] };

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

  /** All upstream tools (prefixed), cached for 60 s. Unreachable upstreams are skipped. */
  async listTools(upstreams: UpstreamServer[]): Promise<Tool[]> {
    if (this.toolCache && Date.now() - this.toolCache.at < 60_000) return this.toolCache.tools;
    const tools: Tool[] = [];
    for (const u of upstreams.filter((x) => x.enabled)) {
      try {
        const res = await (await this.client(u)).listTools();
        for (const t of res.tools) tools.push({ ...t, name: `${u.name}${SEP}${t.name}`, description: `[${u.name}] ${t.description ?? ''}`.trim() });
      } catch (err) {
        this.drop(u.name);
        this.log.warn({ upstream: u.name, err: String(err) }, 'upstream not reachable');
      }
    }
    this.toolCache = { at: Date.now(), tools };
    return tools;
  }

  invalidate() {
    this.toolCache = undefined;
  }

  async call(upstreams: UpstreamServer[], name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult> {
    const idx = name.indexOf(SEP);
    const u = upstreams.find((x) => x.enabled && x.name === name.slice(0, idx));
    if (idx < 0 || !u) throw new Error(`Unknown tool ${name}`);
    try {
      return (await (await this.client(u)).callTool({ name: name.slice(idx + SEP.length), arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult;
    } catch (err) {
      this.drop(u.name);
      throw err;
    }
  }
}
