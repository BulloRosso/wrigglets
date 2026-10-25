import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { nextReply, textOf, type ChatMessage, type ToolDef } from './script.js';

/*
 * OpenAI-compatible chat completions endpoint (`POST /v1/chat/completions`, streaming and
 * non-streaming, tool calls, usage) standing in for the AI gateway.
 */

const PORT = Number(process.env.PORT ?? 4010);
const CHUNK_DELAY_MS = Number(process.env.MOCK_CHUNK_DELAY_MS ?? 25);
const API_KEY = process.env.MOCK_API_KEY; // optional: require this bearer token

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function chat(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req);
  const messages: ChatMessage[] = body.messages ?? [];
  const tools: ToolDef[] | undefined = body.tools;
  const reply = nextReply(messages, tools);
  if (process.env.MOCK_LOG === '1') {
    const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
    console.log(
      JSON.stringify({
        msg: 'request',
        tools: tools?.map((t) => t.function.name),
        systemChars: system.length,
        agentsMd: /AGENTS_MD_MARKER/.test(system),
        lastRole: messages[messages.length - 1]?.role,
        lastToolResult: messages[messages.length - 1]?.role === 'tool' ? textOf(messages[messages.length - 1]!.content).slice(0, 200) : undefined,
        reply: reply.kind === 'tool' ? `${reply.name}(${Object.values(reply.args)[0]})` : reply.text.slice(0, 60),
      }),
    );
  }
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'mock';
  const promptTokens = estimateTokens(messages.map((m) => textOf(m.content)).join('\n'));
  const completionText = reply.kind === 'text' ? reply.text : JSON.stringify(reply.args);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: estimateTokens(completionText),
    total_tokens: promptTokens + estimateTokens(completionText),
  };
  const toolCall =
    reply.kind === 'tool'
      ? { id: `call_${randomUUID().slice(0, 8)}`, type: 'function' as const, function: { name: reply.name, arguments: JSON.stringify(reply.args) } }
      : undefined;
  const finishReason = reply.kind === 'tool' ? 'tool_calls' : 'stop';

  if (!body.stream) {
    send(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: reply.kind === 'text' ? reply.text : null, tool_calls: toolCall ? [toolCall] : undefined },
          finish_reason: finishReason,
        },
      ],
      usage,
    });
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const emit = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);

  emit({ role: 'assistant', content: '' });
  if (reply.kind === 'text') {
    for (const word of reply.text.split(/(?<=\s)/)) {
      emit({ content: word });
      await sleep(CHUNK_DELAY_MS);
    }
  } else if (toolCall) {
    emit({ tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: '' } }] });
    const args = toolCall.function.arguments;
    for (let i = 0; i < args.length; i += 80) {
      emit({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 80) } }] });
      await sleep(CHUNK_DELAY_MS);
    }
  }
  emit({}, finishReason);
  if (body.stream_options?.include_usage) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) return send(res, 200, { status: 'ok' });
    if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) return send(res, 401, { error: { message: 'invalid api key' } });
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: 'mock-large', object: 'model', owned_by: 'mock' }, { id: 'mock-small', object: 'model', owned_by: 'mock' }] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await chat(req, res);
    send(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (err) {
    send(res, 500, { error: { message: String(err) } });
  }
});

server.listen(PORT, () => console.log(JSON.stringify({ msg: 'mock-llm listening', port: PORT })));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
