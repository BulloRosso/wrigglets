import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SecretStore } from '@cw/secrets';
import { observationBody } from '@cw/shared';
import { ZodError } from 'zod';
import { Hub, HubError } from './hub.js';
import { mcpServer } from './mcp.js';
import { Outbox } from './outbox.js';

/*
 * Signals hub (optional module, ADR-0037).
 *
 *   POST /observations   HTTP ingest; bearer = token of an HTTP source configured in the admin console (SHA-256 match)
 *   POST /mcp            MCP upstream for agents behind the gateway (bearer MCP_SIGNALS_TOKEN): observe, list, resolve
 *   GET  /admin/status   connector and outbox status for the admin console (bearer SIGNALS_HUB_TOKEN)
 *
 * IMAP and MQTT connectors come from the configuration the hub polls from the control plane. Every observation goes
 * into a durable outbox first and is forwarded to the control plane, which hands it to the agent.
 */

const PORT = Number(process.env.PORT ?? 7800);
const HUB_TOKEN = process.env.SIGNALS_HUB_TOKEN;
const MCP_TOKEN = process.env.MCP_SIGNALS_TOKEN;
const CONTROL_PLANE_URL = (process.env.CONTROL_PLANE_URL ?? 'http://temporal:8080').replace(/\/$/, '');
if (!HUB_TOKEN || !MCP_TOKEN) throw new Error('SIGNALS_HUB_TOKEN and MCP_SIGNALS_TOKEN are required');

const secrets = SecretStore.fromEnv();
const secret = async (name: string) => {
  if (!secrets) throw new Error('no Key Vault configured (KEYVAULT_URL)');
  return secrets.get(name);
};

let hub: Hub;
const outbox = new Outbox(process.env.DATA_DIR ?? '/data', (e) => hub.deliver(e));
await outbox.load();
hub = new Hub({ controlPlaneUrl: CONTROL_PLANE_URL, token: HUB_TOKEN, secret, outbox });

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const bearer = (req: Request) => req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', config: hub.config?.version ?? null, outbox: outbox.status() }));

/** HTTP ingest. The source decides the agent; the caller cannot choose it. */
app.post('/observations', async (req, res) => {
  const source = hub.httpSource(bearer(req));
  if (!source) return void res.status(401).json({ error: 'unauthorized' });
  const o = observationBody.parse({ ...req.body, source: 'api', reportedBy: `http:${source.id}` });
  const r = await hub.emit(source.agentId, o, `http:${source.id}`);
  hub.countHttp(source.id);
  res.status(202).json(r);
});

app.post('/mcp', async (req, res) => {
  if (!safeEqual(bearer(req), MCP_TOKEN)) return void res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
  const s = mcpServer(hub);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void s.close();
  });
  await s.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const admin = express.Router();
admin.use((req, res, next) => (safeEqual(bearer(req), HUB_TOKEN) ? next() : void res.status(401).json({ error: 'unauthorized' })));
admin.get('/status', (_req, res) => res.json(hub.status()));
admin.get('/failed', (_req, res) => res.json(outbox.failed().slice(-100).reverse()));
app.use('/admin', admin);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return void res.status(400).json({ error: 'validation failed', issues: err.issues });
  if (err instanceof HubError) return void res.status(err.status).json({ error: err.message });
  console.error(JSON.stringify({ msg: 'signals hub error', err: String(err) }));
  res.status(500).json({ error: 'internal error' });
});

hub.startSync();
outbox.start();
const server = app.listen(PORT, () => console.log(JSON.stringify({ msg: 'signals hub listening', port: PORT, controlPlane: CONTROL_PLANE_URL })));

const shutdown = async () => {
  server.close();
  outbox.stop();
  await hub.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
