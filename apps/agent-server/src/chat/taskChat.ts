import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { formatUsd, type Principal, type TaskChatMessage, type TaskState } from '@cw/shared';
import type { ApiDeps } from '../api/context.js';
import { HttpError } from '../api/context.js';
import { logger } from '../logger.js';
import { resolveWorkspacePath } from '../workspace/paths.js';

/*
 * Chat with the agent about a task (ADR-0030). The agent answers with its own model (LiteLLM virtual key, counted in
 * the spend limit) from the task as context: request, plan, step reports, decisions, colleagues' answers, result and
 * the task's files — text files as text, images as images. The chat is read-only: it never changes the workspace.
 * Messages are stored per task (ARTIFACTS_DIR/chat/<taskId>.jsonl) and every question is written to the audit log.
 */

const TEXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'yaml', 'yml', 'mmd', 'mermaid', 'log', 'py', 'xml', 'html', 'ts', 'js']);
const IMAGE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_TEXT_FILE = 40_000;
const MAX_TEXT_TOTAL = 150_000;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_IMAGES = 3;
const HISTORY = 20;

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Part[];
}

const ext = (p: string) => (p.includes('.') ? p.split('.').pop()!.toLowerCase() : '');

export class TaskChat {
  private readonly dir: string;
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly deps: ApiDeps) {
    this.dir = path.join(deps.config.artifactsDir, 'chat');
  }

  private file(taskId: string) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) throw new HttpError(400, 'invalid task id');
    return path.join(this.dir, `${taskId.replace(/:/g, '_')}.jsonl`);
  }

  async list(taskId: string): Promise<TaskChatMessage[]> {
    const text = await readFile(this.file(taskId), 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TaskChatMessage);
  }

  private async append(taskId: string, m: TaskChatMessage) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(taskId), `${JSON.stringify(m)}\n`);
  }

  private rateLimit(upn: string) {
    const now = Date.now();
    const list = (this.recent.get(upn) ?? []).filter((t) => now - t < 10 * 60_000);
    if (list.length >= 30) throw new HttpError(429, 'Too many questions — please wait a few minutes.');
    list.push(now);
    this.recent.set(upn, list);
  }

  /** Files of the task the model gets to see: plan, results and every workspace file a step changed. */
  private taskFiles(state: TaskState, question: string): string[] {
    // files named in the question: `backticked paths` (e.g. inserted by the upload button) and plain paths
    const mentioned = [
      ...[...question.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()),
      ...[...question.matchAll(/(?:^|\s)((?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.[a-zA-Z0-9]{2,5})(?=$|[\s,;:!?)])/gu)].map((m) => m[1]!),
    ];
    const all = [
      ...(state.plan?.path ? [state.plan.path] : []),
      ...(state.result?.outputs ?? []),
      ...state.steps.flatMap((s) => s.filesTouched),
      ...mentioned,
    ];
    return [...new Set(all.filter((f) => f && (!f.startsWith('.agent/') || f.startsWith('.agent/plans/'))))].slice(0, 25);
  }

  private async context(state: TaskState, question: string): Promise<{ parts: Part[]; files: string[] }> {
    const parts: Part[] = [];
    const used: string[] = [];
    let textBudget = MAX_TEXT_TOTAL;
    let images = 0;
    for (const rel of this.taskFiles(state, question)) {
      let abs: string;
      try {
        abs = (await resolveWorkspacePath(this.deps.config.workspaceDir, rel)).abs;
      } catch {
        continue; // not in the workspace (any more)
      }
      const s = await stat(abs).catch(() => undefined);
      if (!s?.isFile()) continue;
      const e = ext(rel);
      if (IMAGE[e] && images < MAX_IMAGES && s.size <= MAX_IMAGE) {
        const data = await readFile(abs);
        parts.push({ type: 'text', text: `Image file \`${rel}\`:` }, { type: 'image_url', image_url: { url: `data:${IMAGE[e]};base64,${data.toString('base64')}` } });
        images++;
        used.push(rel);
      } else if (TEXT.has(e) && textBudget > 0) {
        const text = (await readFile(abs, 'utf8')).slice(0, Math.min(MAX_TEXT_FILE, textBudget));
        textBudget -= text.length;
        parts.push({ type: 'text', text: `File \`${rel}\`:\n\`\`\`\n${text}\n\`\`\`` });
        used.push(rel);
      } else {
        parts.push({ type: 'text', text: `File \`${rel}\` exists (${e || 'no extension'}, ${s.size} bytes) but its content is not available in this chat.` });
      }
    }
    return { parts, files: used };
  }

  private describe(state: TaskState): string {
    const lines = [
      `# Task ${state.taskId}: ${state.title}`,
      `Type: ${state.type} · status: ${state.status} · requested by ${state.requestedBy.name} <${state.requestedBy.upn}> at ${state.createdAt}`,
      '',
      '## Request',
      state.instructions,
    ];
    if (state.steps.length) lines.push('', '## Reports after each step', ...state.steps.map((s) => `- ${s.kind} (${s.endedAt}): ${s.summary}`));
    if (state.decisions.length) lines.push('', '## Decisions', ...state.decisions.map((d) => `- ${d.by.name}: ${d.decision}${d.comment ? ` — ${d.comment}` : ''} (${d.at})`));
    if (state.notes.length) lines.push('', '## Comments', ...state.notes.map((n) => `- ${n.by.name}: ${n.text}`));
    if (state.delegations?.length) lines.push('', '## Colleagues asked', ...state.delegations.map((d) => `- ${d.agentId}: ${d.state}${d.summary ? ` — ${d.summary}` : ''}`));
    if (state.result) lines.push('', '## Result', state.result.summary, ...state.result.outputs.map((o) => `- output: ${o}`));
    if (state.error) lines.push('', `## Error\n${state.error}`);
    return lines.join('\n');
  }

  async ask(taskId: string, state: TaskState, user: Principal, question: string): Promise<TaskChatMessage[]> {
    const c = this.deps.config;
    this.rateLimit(user.upn);
    const spend = await this.deps.spend.get();
    if (spend && !spend.ai.configured) throw new HttpError(409, `No AI model available: ${spend.ai.problem ?? 'not configured'}. ${spend.ai.howToFix ?? ''}`.trim());
    if (spend?.exceeded) throw new HttpError(409, `${c.AGENT_DISPLAY_NAME} has reached the spend limit of ${formatUsd(spend.limitUsd)} for the last ${spend.windowDays} days.`);

    const userMsg: TaskChatMessage = { id: ulid(), at: new Date().toISOString(), role: 'user', by: { upn: user.upn, name: user.name, oid: user.oid }, text: question };
    const history = (await this.list(taskId)).slice(-HISTORY);
    const { parts, files } = await this.context(state, question);
    const messages: ChatCompletionMessage[] = [
      {
        role: 'system',
        content: [
          `You are ${c.AGENT_DISPLAY_NAME}, an AI colleague who works for a team on a shared workspace. ${c.AGENT_DESCRIPTION ?? ''}`.trim(),
          'You are answering questions about one of your tasks. The task, its history and its files are given below.',
          'Answer in the language of the question, concisely, in plain Markdown (tables are fine; no HTML tags such as <br>).',
          'Base your answers on the given context; say clearly when something is not in it. Do not invent facts.',
          'This chat is read-only: you cannot change files or start work here. If the person wants changes, suggest',
          '"Request changes" on a waiting plan or a new task.',
        ].join('\n'),
      },
      { role: 'user', content: [{ type: 'text', text: `${this.describe(state)}\n\n## Files of the task` }, ...parts] },
      { role: 'assistant', content: 'I have read the task and its files. What would you like to know?' },
      ...history.filter((m) => !m.error).map((m): ChatCompletionMessage => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })),
      { role: 'user', content: question },
    ];

    let answer: TaskChatMessage;
    try {
      const res = await fetch(`${c.AI_GATEWAY_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.AI_GATEWAY_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: c.AI_GATEWAY_MODEL, messages }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(body.error?.message ?? `AI gateway returned ${res.status}`);
      const cost = Number(res.headers.get('x-litellm-response-cost'));
      answer = {
        id: ulid(),
        at: new Date().toISOString(),
        role: 'agent',
        text: body.choices?.[0]?.message?.content?.trim() || '(no answer)',
        model: c.AI_GATEWAY_MODEL,
        tokens: body.usage?.total_tokens,
        costUsd: Number.isFinite(cost) ? cost : undefined,
        context: files,
      };
    } catch (err) {
      logger.warn({ taskId, err: String(err) }, 'chat answer failed');
      answer = { id: ulid(), at: new Date().toISOString(), role: 'agent', text: `I could not answer: ${String(err instanceof Error ? err.message : err).slice(0, 400)}`, error: true };
    }
    await this.append(taskId, userMsg);
    await this.append(taskId, answer);
    await this.deps.audit.write({ by: user.upn, action: 'task.chat', target: taskId, details: { tokens: answer.tokens, costUsd: answer.costUsd, files: files.length, error: answer.error } });
    return [userMsg, answer];
  }
}
