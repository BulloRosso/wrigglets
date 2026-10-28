import express, { type Request, type Response } from 'express';
import { pino } from 'pino';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { SecretStore } from '@cw/secrets';
import { A2A_TOOL, toolAllowed, type GatewayAgentConfig, type Identity } from '@cw/shared';
import { A2aBroker } from './a2a.js';
import { hideCallerParams, withCaller } from './caller.js';
import { Audit } from './audit.js';
import { loadConfig } from './config.js';
import { OboClient } from './oboClient.js';
import { authenticateAgent, decideDelegation, decideToolCall, decideUpstreamAuth, visiblePeers } from './policy.js';
import { ConfigSync } from './sync.js';
import { UpstreamPool, upstreamFor } from './upstreams.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'mcp-gateway' }, timestamp: pino.stdTimeFunctions.isoTime });
const env = loadConfig();
const sync = new ConfigSync(env.CONTROL_PLANE_URL, env.GATEWAY_TOKEN, env.SYNC_INTERVAL_MS, env.MAX_STALENESS_MS, log);
const secrets = SecretStore.fromEnv();
const upstreams = new UpstreamPool(secrets, log);
const audit = new Audit(env.DATA_DIR);
const broker = new A2aBroker(env.GATEWAY_TOKEN, env.DATA_DIR);
const obo = new OboClient(env.GATEWAY_TOKEN);

/** What the agent is currently working on (registered by runAgentStep; steps are serialized per agent). */
/** `interactive`: a signed-in user is behind the task (not a schedule or A2A delegation) — only then Entra OBO applies. */
const stepContext = new Map<string, { taskId: string; requestedBy: Identity; interactive: boolean; /** plan | run | fix: while planning only tools that are not declared as changing data may run */ phase?: string }>();

const A2A_TOOLS: Tool[] = [
  {
    name: A2A_TOOL.list,
    description: 'List the other AI colleagues you may delegate work to (their name, description and skills).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: A2A_TOOL.send,
    description:
      'Delegate a task to another AI colleague (A2A). Returns the remote task id. The task runs asynchronously; your task waits for the result automatically after this step.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Id of the colleague (from a2a__list_agents)' },
        title: { type: 'string', description: 'Short title of the delegated task' },
        after: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Task ids (the taskId that earlier a2a__send_task calls returned) that must have COMPLETED before this task starts. The platform holds this task back, starts it only then and gives it the results of those tasks. Use it for every task that depends on the result of a colleague, for example customer notices that need the new delivery dates. Declare the whole chain in this step. If a predecessor fails, this task is cancelled and never started.',
        },
        instructions: { type: 'string', description: 'What the colleague should do and deliver' },
        type: { type: 'string', enum: ['analysis', 'report', 'change'], default: 'report' },
        approval: { type: 'string', enum: ['plan', 'none', 'deviation'], default: 'plan', description: 'Approval policy at the colleague' },
      },
      required: ['agentId', 'title', 'instructions'],
    },
  },
  {
    name: A2A_TOOL.get,
    description: 'Get the status and result of a task delegated to another AI colleague.',
    inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, taskId: { type: 'string' } }, required: ['agentId', 'taskId'] },
  },
];

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], isError });
const bearer = (req: Request) => req.header('authorization')?.replace(/^Bearer\s+/i, '');

function mcpServer(agent: GatewayAgentConfig): Server {
  const server = new Server({ name: 'coworking-gateway', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const config = sync.config;
    if (!config || sync.stale) return { tools: [] };
    // OBO upstreams are discovered with the agent's own token, if the agent and upstream allow agent-only access
    const discover = async (u: (typeof config.upstreams)[number]) => {
      if (!decideUpstreamAuth(u, agent, { interactive: false, hasUserAssertion: false }).allowed || !u.oboScope) return undefined;
      const r = await obo.token(agent, { mode: 'agent-only', scope: u.oboScope });
      return r.ok ? r.accessToken : undefined;
    };
    const upstreamTools = (await upstreams.listTools(config.upstreams, discover)).filter((t) => toolAllowed(agent.allowedTools, t.name)).map(hideCallerParams);
    // A2A tools are always listed (the harness reads the tool list once); calls are checked live.
    return { tools: [...upstreamTools, ...A2A_TOOLS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const argBytes = Buffer.byteLength(JSON.stringify(args));
    const started = Date.now();
    const config = sync.config;
    const record = (outcome: 'ok' | 'error' | 'denied', extra: { reason?: string; resultBytes?: number; peer?: string; remoteTaskId?: string; authMode?: 'static' | 'obo' | 'agent-only'; userOid?: string } = {}) =>
      audit.write({ at: new Date().toISOString(), agentId: agent.agentId, tool, outcome, durationMs: Date.now() - started, argBytes, ...extra });

    const decision = decideToolCall(config, sync.stale, agent, tool);
    if (!decision.allowed) {
      await record('denied', { reason: decision.reason });
      return text(decision.reason, true);
    }
    const limits = config!.limits;
    if (argBytes > limits.maxArgBytes) {
      await record('denied', { reason: 'arguments too large' });
      return text(`Arguments exceed ${limits.maxArgBytes} bytes.`, true);
    }
    if (audit.callsLastMinute(agent.agentId) >= limits.callsPerMinute) {
      await record('denied', { reason: 'rate limit' });
      return text(`Rate limit of ${limits.callsPerMinute} tool calls per minute reached.`, true);
    }

    try {
      // Planning is read-only (enforced, not just requested): nothing may change before a person approved the plan.
      // A tool is refused in the plan step when its MCP server declares it as changing data (readOnlyHint: false);
      // delegating to a colleague is an action as well.
      if (stepContext.get(agent.agentId)?.phase === 'plan') {
        const changes = tool === A2A_TOOL.send || (tool !== A2A_TOOL.list && tool !== A2A_TOOL.get && (await upstreams.annotationsOf(config!.upstreams, tool))?.readOnlyHint === false);
        if (changes) {
          const reason = `${tool} changes data or delegates work, so it can only run in the execute step, after a person has approved the plan. While planning, use read tools only.`;
          await record('denied', { reason: 'plan step is read-only' });
          return text(reason, true);
        }
      }
      if (tool === A2A_TOOL.list) {
        const peers = visiblePeers(config!, agent);
        const cards = await Promise.all(
          peers.map(async (p) => {
            try {
              const card = await broker.card(agent.agentId, p);
              return { agentId: p.agentId, name: card.name, description: card.description, skills: card.skills.map((s) => ({ id: s.id, name: s.name, description: s.description })) };
            } catch {
              return { agentId: p.agentId, name: p.displayName, description: '(currently not reachable)', skills: [] };
            }
          }),
        );
        await record('ok');
        return text(JSON.stringify(cards, null, 2));
      }
      if (tool === A2A_TOOL.send || tool === A2A_TOOL.get) {
        const peerId = String(args.agentId ?? '');
        const peer = config!.agents.find((a) => a.agentId === peerId);
        if (tool === A2A_TOOL.send) {
          const d = decideDelegation(config!, agent, peerId, await broker.liveEdges());
          if (!d.allowed || !peer) {
            await record('denied', { reason: d.allowed ? 'unknown agent' : d.reason, peer: peerId });
            return text(d.allowed ? `Unknown agent ${peerId}` : d.reason, true);
          }
          const input = z
            .object({
              title: z.string().min(3).max(120),
              instructions: z.string().min(1).max(20_000),
              type: z.enum(['analysis', 'report', 'change']).default('report'),
              approval: z.enum(['plan', 'none', 'deviation']).default('plan'),
              after: z.array(z.string().min(1).max(100)).max(5).default([]),
            })
            .parse(args);
          const ctx = stepContext.get(agent.agentId);
          const { after, ...task } = input;
          let r;
          try {
            r = after.length ? await broker.sendAfter(agent, peer, task, { callerTaskId: ctx?.taskId, requestedBy: ctx?.requestedBy }, after) : await broker.send(agent, peer, task, { callerTaskId: ctx?.taskId, requestedBy: ctx?.requestedBy });
          } catch (err) {
            await record('denied', { reason: String(err).slice(0, 200), peer: peerId });
            return text(err instanceof Error ? err.message : String(err), true);
          }
          await record('ok', { peer: peerId, remoteTaskId: r.taskId });
          return text(JSON.stringify({ agentId: peerId, taskId: r.taskId, state: r.state }));
        }
        if (!peer || !agent.peers.includes(peerId)) {
          await record('denied', { reason: 'not a peer', peer: peerId });
          return text(`Agent ${peerId} is not in your discovery set.`, true);
        }
        const s = await broker.status(agent, peer, String(args.taskId ?? ''));
        await record('ok', { peer: peerId, remoteTaskId: s.taskId });
        return text(JSON.stringify(s, null, 2));
      }
      // Entra OBO (optional): per-upstream authentication mode, fail-closed (ADR-0032)
      let accessToken: string | undefined;
      let authAudit: { authMode?: 'static' | 'obo' | 'agent-only'; userOid?: string } = {};
      const upstream = upstreamFor(config!.upstreams, tool);
      if (upstream?.auth === 'obo') {
        const ctx = stepContext.get(agent.agentId);
        const oid = ctx?.requestedBy?.oid;
        const interactive = ctx?.interactive === true && !!oid;
        const auth = decideUpstreamAuth(upstream, agent, { interactive, hasUserAssertion: true });
        if (!auth.allowed || auth.mode === 'static') {
          const reason = auth.allowed ? 'OBO upstream resolved to static authentication' : auth.reason;
          await record('denied', { reason, userOid: oid });
          return text(reason, true);
        }
        const t = await obo.token(agent, { mode: auth.mode, scope: upstream.oboScope!, oid: auth.mode === 'obo' ? oid : undefined });
        if (!t.ok) {
          // no user sign-in, or consent needed: never downgrade an interactive task to agent-only
          await record('denied', { reason: `${t.code}: ${t.message}`, authMode: auth.mode, userOid: oid });
          return text(t.message, true);
        }
        accessToken = t.accessToken;
        authAudit = { authMode: auth.mode, userOid: oid };
      }
      const def = (await upstreams.listTools(config!.upstreams)).find((t) => t.name === tool);
      const ctx = stepContext.get(agent.agentId);
      const callArgs = withCaller(def, args, { agentId: agent.agentId, taskId: ctx?.taskId, requestedBy: ctx?.requestedBy?.upn });
      const result = await upstreams.call(config!.upstreams, tool, callArgs, limits.callTimeoutMs, accessToken);
      await record(result.isError ? 'error' : 'ok', { resultBytes: Buffer.byteLength(JSON.stringify(result.content ?? '')), ...authAudit });
      return result;
    } catch (err) {
      await record('error', { reason: String(err).slice(0, 300) });
      return text(`Tool call failed: ${String(err).slice(0, 500)}`, true);
    }
  });
  return server;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.status(sync.stale ? 503 : 200).json({ status: sync.stale ? 'stale' : 'ok', lastSync: new Date(sync.lastSync).toISOString(), keyVault: !!secrets });
});

/* -------------------------------------------------- MCP endpoint per agent (Streamable HTTP, stateless) */
const mcpHandler = async (req: Request, res: Response) => {
  const agent = authenticateAgent(sync.config, String(req.params.agentId), bearer(req));
  if (!agent) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
    return;
  }
  const server = mcpServer(agent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
};
app.post('/agents/:agentId/mcp', mcpHandler);
app.get('/agents/:agentId/mcp', (_req, res) => res.status(405).set('allow', 'POST').end());
app.delete('/agents/:agentId/mcp', (_req, res) => res.status(405).set('allow', 'POST').end());

/* -------------------------------------------------- agent-facing REST (agent token) */
const agentAuth = (req: Request, res: Response): GatewayAgentConfig | undefined => {
  const agent = authenticateAgent(sync.config, String(req.params.agentId), bearer(req));
  if (!agent) res.status(401).json({ error: 'unauthorized' });
  return agent;
};

/** runAgentStep registers what the agent is working on (used as "on behalf of" for delegations). */
app.put('/agents/:agentId/step-context', (req, res) => {
  const agent = agentAuth(req, res);
  if (!agent) return;
  if (req.body?.taskId) stepContext.set(agent.agentId, { taskId: String(req.body.taskId), requestedBy: req.body.requestedBy as Identity, interactive: req.body.interactive === true, phase: typeof req.body.phase === 'string' ? req.body.phase : undefined });
  else stepContext.delete(agent.agentId);
  res.status(204).end();
});

/** Tools their MCP server declares read-only (`readOnlyHint: true`), by gateway name; the agent's guard may skip them (opt-in). */
app.get('/agents/:agentId/tools/read-only', async (req, res) => {
  const agent = agentAuth(req, res);
  if (!agent || !sync.config) return;
  const tools = await upstreams.listTools(sync.config.upstreams);
  res.json({ tools: [...tools.filter((t) => t.annotations?.readOnlyHint === true && toolAllowed(agent.allowedTools, t.name)).map((t) => t.name), A2A_TOOL.list, A2A_TOOL.get] });
});

/** Status of delegated tasks (used by the caller's TaskWorkflow while it waits). */
app.post('/agents/:agentId/a2a/status', async (req, res) => {
  const agent = agentAuth(req, res);
  if (!agent || !sync.config) return;
  const list = z.array(z.object({ agentId: z.string(), taskId: z.string() })).max(20).parse(req.body?.delegations ?? []);
  const out = await Promise.all(
    list.map(async (d) => {
      const peer = sync.config!.agents.find((a) => a.agentId === d.agentId);
      if (!peer) return { ...d, state: 'unknown' as const, terminal: true, summary: 'agent no longer exists' };
      try {
        return await broker.status(agent, peer, d.taskId);
      } catch (err) {
        return { ...d, state: 'unknown' as const, terminal: false, summary: String(err).slice(0, 200) };
      }
    }),
  );
  res.json(out);
});

/* -------------------------------------------------- control-plane-facing (gateway token) */
const internal = express.Router();
internal.use((req, res, next) => (bearer(req) === env.GATEWAY_TOKEN ? next() : res.status(401).json({ error: 'unauthorized' })));
internal.post('/refresh', async (_req, res) => {
  const ok = await sync.refresh();
  upstreams.invalidate();
  res.json({ ok });
});
internal.get('/stats', (_req, res) => {
  res.json(Object.fromEntries((sync.config?.agents ?? []).map((a) => [a.agentId, audit.stats(a.agentId)])));
});
internal.get('/audit', async (req, res) => {
  res.json(await audit.tail(req.query.agentId ? String(req.query.agentId) : undefined, Math.min(Number(req.query.limit ?? 100) || 100, 1000)));
});
internal.get('/tools', async (_req, res) => {
  if (!sync.config) return res.json([]);
  res.json((await upstreams.listTools(sync.config.upstreams)).map((t) => ({ name: t.name, description: t.description })));
});
app.use('/internal', internal);

await broker.load();
broker.setConfigSource(() => sync.config);
sync.start();
app.listen(env.PORT, () => log.info({ port: env.PORT, keyVault: env.KEYVAULT_URL }, 'mcp gateway listening'));
