import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/*
 * Demo upstream MCP server standing in for a company system (supplier directory, FX rates).
 * Requires `Authorization: Bearer <DEMO_TOKEN>` — the MCP gateway reads that token from Key Vault.
 */

const PORT = Number(process.env.PORT ?? 7500);
const TOKEN = process.env.DEMO_TOKEN;
if (!TOKEN) throw new Error('DEMO_TOKEN is required');

const SUPPLIERS = [
  { name: 'Kranz GmbH', city: 'Essen', category: 'Electrical components', rating: 'A', deliveryDays: 12, contact: 'einkauf@kranz.example' },
  { name: 'Nordwind Logistik AG', city: 'Hamburg', category: 'Logistics', rating: 'B', deliveryDays: 5, contact: 'sales@nordwind.example' },
  { name: 'Rheintal Stahl KG', city: 'Duisburg', category: 'Steel', rating: 'A', deliveryDays: 21, contact: 'vertrieb@rheintal.example' },
  { name: 'Alpen Solar GmbH', city: 'Rosenheim', category: 'Photovoltaics', rating: 'C', deliveryDays: 30, contact: 'info@alpensolar.example' },
];
const RATES: Record<string, number> = { EUR: 1, USD: 1.08, GBP: 0.85, CHF: 0.94 };

function server() {
  const s = new Server({ name: 'demo-company-systems', version: '0.1.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'supplier_lookup',
        description: 'Look up suppliers in the company supplier directory by (partial) name or category.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Name or category' } }, required: ['query'] },
      },
      {
        name: 'fx_rate',
        description: 'Current exchange rate between two currencies (EUR, USD, GBP, CHF).',
        inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, string>;
    if (req.params.name === 'supplier_lookup') {
      const q = String(a.query ?? '').toLowerCase();
      const hits = SUPPLIERS.filter((x) => x.name.toLowerCase().includes(q) || x.category.toLowerCase().includes(q));
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
    }
    if (req.params.name === 'fx_rate') {
      const from = RATES[String(a.from).toUpperCase()];
      const to = RATES[String(a.to).toUpperCase()];
      if (!from || !to) return { content: [{ type: 'text', text: 'Unknown currency' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({ from: a.from, to: a.to, rate: Number((to / from).toFixed(4)), asOf: new Date().toISOString().slice(0, 10) }) }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }], isError: true };
  });
  return s;
}

const app = express();
app.use(express.json());
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
app.listen(PORT, () => console.log(JSON.stringify({ msg: 'mcp-demo listening', port: PORT })));
