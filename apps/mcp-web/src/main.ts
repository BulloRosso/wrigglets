import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebError, fetchUrl, search } from './web.js';

/*
 * Web access as an upstream MCP server (ADR-0031). Only the MCP gateway calls it (bearer WEB_TOKEN, kept in Key Vault);
 * agents get the tools `web__search` and `web__fetch_url` when an admin allows them for the agent.
 */

const PORT = Number(process.env.PORT ?? 7600);
const TOKEN = process.env.WEB_TOKEN;
if (!TOKEN) throw new Error('WEB_TOKEN is required');

function server() {
  const s = new Server({ name: 'web', version: '0.1.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search',
        description: 'Search the public web. Returns titles, URLs and snippets; use fetch_url to read a result. Cite the URLs you use.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search terms' }, max_results: { type: 'number', description: 'Number of results (1–15, default 8)' } },
          required: ['query'],
        },
      },
      {
        name: 'fetch_url',
        description: 'Read a public web page (HTML is converted to readable text, links kept as Markdown) or a text/JSON resource. Only public http(s) addresses.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'http(s) URL' }, max_chars: { type: 'number', description: 'Maximum characters to return (default 20000, max 60000)' } },
          required: ['url'],
        },
      },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (req.params.name === 'search') {
        const hits = await search(String(a.query ?? ''), Number(a.max_results ?? 8) || 8);
        const text = hits.length ? hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n') : 'No results.';
        return { content: [{ type: 'text', text }] };
      }
      if (req.params.name === 'fetch_url') {
        return { content: [{ type: 'text', text: await fetchUrl(String(a.url ?? ''), Number(a.max_chars ?? 20_000) || 20_000) }] };
      }
      return { content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }], isError: true };
    } catch (err) {
      const msg = err instanceof WebError ? err.message : `Request failed: ${err instanceof Error ? err.message : String(err)}`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  });
  return s;
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.post('/mcp', async (req, res) => {
  if (req.header('authorization') !== `Bearer ${TOKEN}`) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
    return;
  }
  const s = server();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void s.close();
  });
  await s.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(PORT, () => console.log(JSON.stringify({ msg: 'mcp-web listening', port: PORT })));
