import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { z } from 'zod';
import { SCHEDULE_TIMEZONE, createScheduleBody, formatUsd, toIdentity, type Principal, type TaskChatMessage, type TaskState } from '@cw/shared';
import type { ApiDeps } from '../api/context.js';
import { HttpError } from '../api/context.js';
import { logger } from '../logger.js';
import { createUserSchedule } from '../schedules/create.js';
import { resolveWorkspacePath } from '../workspace/paths.js';

/*
 * Chat with the agent about a task (ADR-0030). The agent answers with its own model (LiteLLM virtual key, counted in
 * the spend limit) from the task as context: request, plan, step reports, decisions, colleagues' answers, result and
 * the task's files — text files as text, images as images. The chat is read-only: it never changes the workspace.
 * Messages are stored per task (ARTIFACTS_DIR/chat/<taskId>.jsonl) and every question is written to the audit log.
 *
 * The one thing the agent can do here is *propose* a recurring task (tool `propose_schedule`, ADR-0034). A proposal is
 * only a chat message with status "pending": the schedule is created when the person who asked clicks "Approve".
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

const { $schema: _schema, ...SCHEDULE_PARAMETERS } = z.toJSONSchema(createScheduleBody, { io: 'input' }) as Record<string, unknown>;
const PROPOSE_SCHEDULE = {
  type: 'function',
  function: {
    name: 'propose_schedule',
    description:
      'Propose a recurring (or one-time future) task for the person to approve. Nothing is scheduled until they approve it with a button. ' +
      'Use it when the person asks to repeat this task or to run something on a schedule. The instructions must be complete and self-contained: ' +
      `a scheduled run does not see this chat. Times are in ${SCHEDULE_TIMEZONE}; weekly dayOfWeek is 0 = Sunday … 6 = Saturday.`,
    parameters: SCHEDULE_PARAMETERS,
  },
} as const;

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

  /** Appends and rewrites of one chat file never interleave (a proposal is changed in place when it is decided). */
  private readonly locks = new Map<string, Promise<unknown>>();
  private locked<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(taskId) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(taskId, run.catch(() => undefined));
    return run;
  }

  private append(taskId: string, ...ms: TaskChatMessage[]) {
    return this.locked(taskId, async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file(taskId), ms.map((m) => `${JSON.stringify(m)}\n`).join(''));
    });
  }

  /**
   * Approve or reject a schedule the agent proposed. Only the person whose question led to the proposal (or an admin)
   * may decide; on approval they become the owner of the schedule, so it runs with their name and approvals.
   */
  decideProposal(taskId: string, messageId: string, user: Principal, decision: 'approve' | 'reject'): Promise<TaskChatMessage> {
    return this.locked(taskId, async () => {
      const all = await this.list(taskId);
      const m = all.find((x) => x.id === messageId);
      const p = m?.proposal;
      if (!m || !p) throw new HttpError(404, 'proposal not found');
      if (p.status !== 'pending') throw new HttpError(409, `This proposal was already ${p.status}`);
      if (p.requestedBy.upn !== user.upn && !user.roles.includes(this.deps.config.roles.admin)) throw new HttpError(403, 'Only the person who asked for the schedule (or an admin) may decide');
      const by = toIdentity(user);
      p.decidedBy = by;
      p.decidedAt = new Date().toISOString();
      if (decision === 'approve') {
        p.scheduleId = await createUserSchedule(this.deps, p.schedule, by, { via: 'chat', taskId, proposalId: messageId });
        p.status = 'approved';
      } else {
        p.status = 'rejected';
        await this.deps.audit.write({ by: user.upn, action: 'schedule.proposal_rejected', target: taskId, details: { title: p.schedule.title, proposalId: messageId } });
      }
      await writeFile(this.file(taskId), all.map((x) => `${JSON.stringify(x)}\n`).join(''));
      return m;
    });
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
          'The only thing you can do is call propose_schedule when the person wants this task repeated or run at a later time.',
          'It shows them a card with Approve and Reject buttons; you cannot create a schedule yourself. Until they approve,',
          'never say that a schedule exists. Ask when day or time is unclear instead of guessing. After proposing, say in one',
          'or two sentences what you proposed and that it needs their approval.',
          `Now: ${new Date().toISOString()} (UTC); schedule times are in ${SCHEDULE_TIMEZONE}.`,
        ].join('\n'),
      },
      { role: 'user', content: [{ type: 'text', text: `${this.describe(state)}\n\n## Files of the task` }, ...parts] },
      { role: 'assistant', content: 'I have read the task and its files. What would you like to know?' },
      ...history
        .filter((m) => !m.error)
        .map((m): ChatCompletionMessage => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.proposal ? `${m.text}\n\n[Schedule proposal "${m.proposal.schedule.title}": ${m.proposal.status}]` : m.text,
        })),
      { role: 'user', content: question },
    ];

    let answer: TaskChatMessage;
    try {
      const res = await fetch(`${c.AI_GATEWAY_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.AI_GATEWAY_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: c.AI_GATEWAY_MODEL, messages, tools: [PROPOSE_SCHEDULE] }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
        usage?: { total_tokens?: number };
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(body.error?.message ?? `AI gateway returned ${res.status}`);
      const cost = Number(res.headers.get('x-litellm-response-cost'));
      const message = body.choices?.[0]?.message;
      let text = message?.content?.trim() ?? '';
      let proposal: TaskChatMessage['proposal'];
      const call = message?.tool_calls?.find((t) => t.function?.name === 'propose_schedule');
      if (call) {
        try {
          const schedule = createScheduleBody.parse(JSON.parse(call.function?.arguments ?? '{}'));
          proposal = { schedule, status: 'pending', requestedBy: toIdentity(user) };
          text ||= `I propose to run **${schedule.title}** on a schedule. Please approve or reject it below.`;
        } catch (err) {
          logger.warn({ taskId, err: String(err) }, 'invalid schedule proposal');
          text ||= 'I tried to propose a schedule but it was not valid. Could you tell me the day, time and what should be done each time?';
        }
      }
      answer = {
        id: ulid(),
        at: new Date().toISOString(),
        role: 'agent',
        text: text || '(no answer)',
        proposal,
        model: c.AI_GATEWAY_MODEL,
        tokens: body.usage?.total_tokens,
        costUsd: Number.isFinite(cost) ? cost : undefined,
        context: files,
      };
    } catch (err) {
      logger.warn({ taskId, err: String(err) }, 'chat answer failed');
      answer = { id: ulid(), at: new Date().toISOString(), role: 'agent', text: `I could not answer: ${String(err instanceof Error ? err.message : err).slice(0, 400)}`, error: true };
    }
    await this.append(taskId, userMsg, answer);
    await this.deps.audit.write({
      by: user.upn,
      action: 'task.chat',
      target: taskId,
      details: { tokens: answer.tokens, costUsd: answer.costUsd, files: files.length, error: answer.error, proposedSchedule: answer.proposal?.schedule.title },
    });
    return [userMsg, answer];
  }
}
