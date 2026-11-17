import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import { BUSINESS_TASK_QUEUE, approvalStateQuery, decideUpdate, withdrawSignal, type ApprovalState } from '@cw/business-workflows';

/*
 * One approval mechanism (ADR-0049): every decision a person takes in Liquid Enterprise is an ApprovalWorkflow —
 * four-eyes actions, playbook human steps, company-wiki proposals (mirrored here) — listed in one inbox and mailed
 * with a deep link (ADR-0026 pattern). Config changes are pull requests on the Git host; plan approvals of agent tasks
 * stay with the agent (its approver policy); both appear in the inbox as links.
 */

export interface InboxItem {
  id: string;
  kind: 'action' | 'playbook-step' | 'wiki' | 'config' | 'plan';
  subject: string;
  requestedBy: string;
  createdAt: string;
  state: string;
  /** Decided here (ApprovalWorkflow) or elsewhere (link). */
  decideHere: boolean;
  link: string;
  detail?: Record<string, unknown>;
}

export interface ApprovalDeps {
  client: () => Client | undefined;
  publicUrl: string;
  wiki?: { list(): Promise<Array<{ id: string; path: string; reason: string; agent: string; requestedBy?: string; createdAt: string; status: string }>>; decide(id: string, decision: 'approve' | 'reject', by: string, comment?: string): Promise<unknown> };
  configProposals(): Array<{ id: string; title: string; author: { id: string; user?: string }; createdAt: string; status: string; pr?: { number: number; url: string }; validation: { ok: boolean } }>;
  plans(): Promise<Array<{ taskId: string; agentId: string; title: string; requestedBy?: string; createdAt: string; link: string }>>;
  approvers(): Promise<string[]>;
  mail(o: { to: string[]; subject: string; html: string; ref: string }): Promise<void>;
  dataDir: string;
  log?: { warn(o: object, m: string): void };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class ApprovalService {
  private mailed = new Set<string>();
  private readonly file: string;
  private timer?: NodeJS.Timeout;

  constructor(private readonly d: ApprovalDeps) {
    this.file = path.join(d.dataDir, 'liquid', 'approvals-mailed.json');
  }

  async load() {
    try {
      this.mailed = new Set(JSON.parse(await readFile(this.file, 'utf8')) as string[]);
    } catch {
      /* first start */
    }
  }

  private c() {
    const c = this.d.client();
    if (!c) throw new Error('Temporal is not connected');
    return c;
  }

  link(id: string) {
    return `${this.d.publicUrl}/liquid/approvals?focus=${encodeURIComponent(id)}`;
  }

  /** Every pending decision, newest first. */
  async inbox(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for await (const w of this.c().workflow.list({ query: "WorkflowType = 'ApprovalWorkflow' AND ExecutionStatus = 'Running'", pageSize: 200 })) {
      const s = (await this.c()
        .workflow.getHandle(w.workflowId)
        .query(approvalStateQuery)
        .catch(() => undefined)) as ApprovalState | undefined;
      if (!s) continue;
      items.push({ id: w.workflowId, kind: s.kind ?? 'action', subject: s.subject ?? s.request.action, requestedBy: s.request.caller.agent ?? s.request.caller.user ?? s.request.caller.workflow ?? 'unknown', createdAt: w.startTime.toISOString(), state: s.state, decideHere: true, link: this.link(w.workflowId), detail: { action: s.request.action, args: s.request.args, reason: s.request.reason, objects: s.request.objects, effect: s.request.effect, caller: s.request.caller } });
    }
    for (const p of this.d.configProposals().filter((x) => x.status === 'pending' && x.pr)) items.push({ id: `config:${p.id}`, kind: 'config', subject: p.title, requestedBy: p.author.user ? `${p.author.id} for ${p.author.user}` : p.author.id, createdAt: p.createdAt, state: p.validation.ok ? 'valid' : 'invalid', decideHere: false, link: p.pr!.url, detail: { proposal: p.id } });
    for (const t of await this.d.plans().catch(() => [])) items.push({ id: `plan:${t.taskId}`, kind: 'plan', subject: t.title, requestedBy: t.requestedBy ?? t.agentId, createdAt: t.createdAt, state: 'awaiting approval', decideHere: false, link: t.link, detail: { agent: t.agentId, task: t.taskId } });
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async decide(workflowId: string, decision: 'approve' | 'reject', by: string, comment?: string): Promise<ApprovalState> {
    try {
      return await this.c().workflow.getHandle(workflowId).executeUpdate(decideUpdate, { args: [{ decision, by, comment }] });
    } catch (err) {
      const e = err as Error & { cause?: Error };
      throw Object.assign(new Error(e.cause?.message ?? e.message), { status: 409 });
    }
  }

  /** Applies a decision of a kind that lives outside the ontology (called by the ApprovalWorkflow's activity). */
  async apply(i: { kind: string; effect: Record<string, unknown>; decision: { decision: 'approve' | 'reject'; by: string; comment?: string } }): Promise<{ ok: boolean; result: string }> {
    if (i.kind === 'wiki') {
      if (!this.d.wiki) return { ok: false, result: 'the company wiki is not configured' };
      await this.d.wiki.decide(String(i.effect.proposalId), i.decision.decision, i.decision.by, i.decision.comment);
      return { ok: true, result: `wiki proposal ${String(i.effect.proposalId)} ${i.decision.decision}d by ${i.decision.by}` };
    }
    return { ok: false, result: `nothing to apply for ${i.kind}` };
  }

  /** Mirrors wiki proposals into ApprovalWorkflows and mails every new approval with a deep link. */
  async tick() {
    if (this.d.wiki) {
      const pending = await this.d.wiki.list().catch(() => undefined);
      if (pending) {
        const open = new Set(pending.filter((p) => p.status === 'pending').map((p) => p.id));
        for (const p of pending.filter((x) => x.status === 'pending')) {
          await this.c()
            .workflow.start('ApprovalWorkflow', {
              taskQueue: BUSINESS_TASK_QUEUE,
              workflowId: `ApprovalWorkflow-wiki-${p.id}`,
              args: [{ kind: 'wiki', subject: `Wiki: ${p.path}`, requestSeq: 0, action: 'wiki_proposal', args: { path: p.path }, caller: { agent: p.agent, user: p.requestedBy }, reason: p.reason, objects: [], effect: { proposalId: p.id, path: p.path }, reminderMs: 86_400_000, expireMs: 14 * 86_400_000 }],
            })
            .catch(() => undefined); // already mirrored
        }
        // decided in the wiki page itself: the approval is withdrawn
        for await (const w of this.c().workflow.list({ query: "WorkflowType = 'ApprovalWorkflow' AND ExecutionStatus = 'Running' AND WorkflowId STARTS_WITH 'ApprovalWorkflow-wiki-'", pageSize: 200 })) {
          const id = w.workflowId.slice('ApprovalWorkflow-wiki-'.length);
          if (!open.has(id)) await this.c().workflow.getHandle(w.workflowId).signal(withdrawSignal, { reason: 'decided in the wiki' }).catch(() => undefined);
        }
      }
    }
    const items = await this.inbox().catch(() => []);
    const fresh = items.filter((i) => !this.mailed.has(i.id) && i.kind !== 'plan');
    if (fresh.length) {
      const to = await this.d.approvers().catch(() => []);
      for (const i of fresh) {
        if (to.length)
          await this.d
            .mail({
              to,
              ref: i.id,
              subject: `Approval needed: ${i.subject}`,
              html: `<p><b>${esc(i.subject)}</b></p><p>Requested by ${esc(i.requestedBy)} (${esc(i.kind)}).</p><p><a href="${esc(i.decideHere ? this.link(i.id) : i.link)}">Open and decide</a></p><p style="color:#666">Liquid Enterprise — every decision of a person is recorded in the event log.</p>`,
            })
            .catch((err: unknown) => this.d.log?.warn({ err: String(err) }, 'approval mail not sent'));
        this.mailed.add(i.id);
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify([...this.mailed].slice(-2000)));
      await rename(`${this.file}.tmp`, this.file);
    }
  }

  start(enabled: () => boolean, intervalMs = 15_000) {
    const loop = async () => {
      try {
        if (enabled()) await this.tick();
      } catch (err) {
        this.d.log?.warn({ err: String(err) }, 'approvals tick failed');
      }
      this.timer = setTimeout(() => void loop(), intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(() => void loop(), 10_000);
    this.timer.unref?.();
  }
}
