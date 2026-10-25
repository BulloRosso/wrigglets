import path from 'node:path';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';
import type { AssistantMessage, Event as OcEvent, Message, Part, ToolPart } from '@opencode-ai/sdk/v2';

/*
 * The only module that talks to the Agent Harness API (spec §6.3). Verified against
 * @opencode-ai/sdk 1.19.4 (v2 client, flat parameters).
 */

export type HarnessEvent = OcEvent;
export type HarnessMessage = { info: Message; parts: Part[] };

export interface HarnessTurnResult {
  finalText: string;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; total: number };
  cost?: number;
  toolCalls: Array<{ tool: string; status: 'ok' | 'error'; title?: string }>;
  filesTouched: string[];
  /** Tasks delegated via the gateway tool `a2a__send_task` (ADR-0023). */
  delegations: Array<{ agentId: string; taskId: string }>;
  error?: { kind: 'aborted' | 'provider' | 'permission' | 'unknown'; message: string };
}

export interface HarnessClient {
  health(): Promise<{ healthy: boolean; version: string }>;
  createSession(input: { title: string }): Promise<{ sessionId: string }>;
  sessionExists(sessionId: string): Promise<boolean>;
  prompt(input: { sessionId: string; text: string; model?: { providerID: string; modelID: string }; signal?: AbortSignal }): Promise<HarnessTurnResult>;
  abort(sessionId: string): Promise<void>;
  messages(sessionId: string): Promise<HarnessMessage[]>;
  rejectPermission(requestId: string): Promise<void>;
  events(signal: AbortSignal): AsyncIterable<HarnessEvent>;
}

const FILE_TOOLS = new Set(['write', 'edit', 'multiedit', 'patch', 'apply_patch']);

export class OpencodeHarnessClient implements HarnessClient {
  private readonly client: OpencodeClient;

  constructor(
    private readonly baseUrl: string,
    private readonly authHeader: () => string,
    private readonly workspaceDir: string,
  ) {
    const authFetch: typeof fetch = (input, init) => {
      const req = new Request(input as string | URL | Request, init);
      req.headers.set('authorization', this.authHeader());
      return fetch(req);
    };
    this.client = createOpencodeClient({ baseUrl, fetch: authFetch, throwOnError: true });
  }

  async health() {
    const r = await this.client.global.health();
    return { healthy: !!r.data?.healthy, version: r.data?.version ?? 'unknown' };
  }

  async createSession({ title }: { title: string }) {
    const r = await this.client.session.create({ title });
    return { sessionId: r.data!.id };
  }

  async sessionExists(sessionId: string) {
    try {
      await this.client.session.get({ sessionID: sessionId });
      return true;
    } catch {
      return false;
    }
  }

  async prompt({ sessionId, text, model, signal }: { sessionId: string; text: string; model?: { providerID: string; modelID: string }; signal?: AbortSignal }) {
    const r = await this.client.session.prompt(
      { sessionID: sessionId, model, parts: [{ type: 'text', text }] },
      { signal },
    );
    const last = r.data!.info;
    // A turn consists of several assistant messages (one per model round-trip); all of them
    // have the user's message as parent. Aggregate usage and tool calls across them.
    const all = await this.messages(sessionId);
    const turn = all.filter((m) => m.info.role === 'assistant' && (m.info as AssistantMessage).parentID === last.parentID);
    return summarizeTurn(turn.length ? turn : [{ info: last, parts: r.data!.parts }], this.workspaceDir);
  }

  async abort(sessionId: string) {
    await this.client.session.abort({ sessionID: sessionId });
  }

  async messages(sessionId: string): Promise<HarnessMessage[]> {
    const r = await this.client.session.messages({ sessionID: sessionId });
    return (r.data ?? []) as HarnessMessage[];
  }

  async rejectPermission(requestId: string) {
    await this.client.permission.reply({ requestID: requestId, reply: 'reject', message: 'Headless agent: permission requests are not allowed' });
  }

  async *events(signal: AbortSignal): AsyncIterable<HarnessEvent> {
    const r = await this.client.event.subscribe(undefined, { signal, sseMaxRetryAttempts: 0 } as never);
    for await (const ev of r.stream) {
      if (signal.aborted) return;
      yield ev as HarnessEvent;
    }
  }
}

export function summarizeTurn(turn: HarnessMessage[], workspaceDir: string): HarnessTurnResult {
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, total: 0 };
  let cost = 0;
  let finalText = '';
  let error: HarnessTurnResult['error'];
  const toolCalls: HarnessTurnResult['toolCalls'] = [];
  const files = new Set<string>();
  const delegations: HarnessTurnResult['delegations'] = [];
  const rel = (p: string) => {
    const r = path.posix.isAbsolute(p) ? path.posix.relative(workspaceDir, p) : p;
    return r.startsWith('..') ? undefined : r;
  };

  for (const m of turn) {
    const info = m.info as AssistantMessage;
    if (info.tokens) {
      tokens.input += info.tokens.input ?? 0;
      tokens.output += info.tokens.output ?? 0;
      tokens.reasoning += info.tokens.reasoning ?? 0;
      tokens.cacheRead += info.tokens.cache?.read ?? 0;
    }
    cost += info.cost ?? 0;
    if (info.error) error = classifyError(info.error);
    for (const part of m.parts) {
      if (part.type === 'text' && !part.synthetic && part.text.trim()) finalText = part.text;
      if (part.type === 'tool') {
        const tp = part as ToolPart;
        const st = tp.state;
        toolCalls.push({
          tool: tp.tool,
          status: st.status === 'error' ? 'error' : 'ok',
          title: st.status === 'completed' || st.status === 'running' ? st.title : undefined,
        });
        if (tp.tool.endsWith('a2a__send_task') && st.status === 'completed') {
          try {
            const out = JSON.parse(st.output) as { agentId?: string; taskId?: string };
            if (out.agentId && out.taskId) delegations.push({ agentId: out.agentId, taskId: out.taskId });
          } catch {
            /* tool reported an error text */
          }
        }
        if (FILE_TOOLS.has(tp.tool) && st.status === 'completed') {
          const p = (st.input.filePath ?? st.input.path) as string | undefined;
          const r = p ? rel(p) : undefined;
          if (r) files.add(r);
        }
      }
      if (part.type === 'patch') for (const f of part.files) {
        const r = rel(f);
        if (r) files.add(r);
      }
    }
  }
  tokens.total = tokens.input + tokens.output + tokens.reasoning;
  return { finalText, tokens, cost: cost || undefined, toolCalls, filesTouched: [...files], delegations, error };
}

function classifyError(e: NonNullable<AssistantMessage['error']>): HarnessTurnResult['error'] {
  const message = 'message' in e.data && typeof e.data.message === 'string' ? e.data.message : e.name;
  switch (e.name) {
    case 'MessageAbortedError':
      return { kind: 'aborted', message };
    case 'APIError':
    case 'ProviderAuthError':
    case 'ContextOverflowError':
    case 'MessageOutputLengthError':
      return { kind: 'provider', message };
    default:
      return { kind: 'unknown', message };
  }
}
