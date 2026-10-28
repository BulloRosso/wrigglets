import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DelegationStatus } from '@cw/shared';
import type { SendTaskInput } from './a2a.js';

/*
 * Ordered delegation (ADR-0036). An agent can declare that a delegated task depends on the results of earlier ones
 * (`a2a__send_task` with `after`). The gateway then holds the task back: it is sent to the colleague only when all
 * predecessors have COMPLETED, and it carries their results. If a predecessor fails, is rejected or is cancelled, the task
 * is not started at all and is reported as cancelled, so nothing runs on missing or wrong input.
 *
 * Why in the platform: before, the order of dependent work (customer notices only after the new dates exist) was only a
 * sentence in the agent's plan, and an agent that forgot the follow-up left the customers uninformed. Now the whole chain
 * is declared while the approved plan is fresh, and the platform keeps the order.
 *
 * The caller's TaskWorkflow polls `/a2a/status` for its delegations (every 30 s); every poll advances the queue.
 */

export interface DelegationRef {
  agentId: string;
  taskId: string;
}

export interface QueuedDelegation {
  id: string;
  from: string;
  to: string;
  input: SendTaskInput;
  after: DelegationRef[];
  callerTaskId?: string;
  requestedBy?: { upn: string; name: string; oid: string };
  at: string;
  state: 'waiting' | 'dispatched' | 'canceled';
  remoteTaskId?: string;
  reason?: string;
}

export interface QueueDeps {
  /** Status of a task that already exists at the colleague (never a queue id). */
  remoteStatus: (from: string, ref: DelegationRef) => Promise<DelegationStatus>;
  /** Sends the task to the colleague. Returns the remote task id. */
  dispatch: (q: QueuedDelegation, instructions: string) => Promise<{ taskId: string }>;
  /** Reason why the task may not start now (colleague paused, loop…), or undefined. */
  blocked: (q: QueuedDelegation) => string | undefined | Promise<string | undefined>;
}

interface Persisted {
  queued: QueuedDelegation[];
  /** Task ids this gateway handed out, to resolve `after` references (newest last). */
  known: Array<DelegationRef & { from: string }>;
}

const MAX_RESULT = 6_000;
const MAX_ENTRIES = 300;
const MAX_AFTER = 5;

export const isQueueId = (id: string) => id.startsWith('q-');

export class DelegationQueue {
  private data: Persisted = { queued: [], known: [] };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly deps: QueueDeps,
  ) {}

  async load() {
    this.data = { queued: [], known: [], ...(JSON.parse(await readFile(this.file, 'utf8').catch(() => '{}')) as Partial<Persisted>) };
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.data));
    await rename(`${this.file}.tmp`, this.file);
  }

  /** Serializes everything that reads or changes the queue, so two polls never dispatch the same task twice. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const r = await fn();
      await this.persist();
      return r;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Remember a task id handed to an agent (so that it can be named in `after`). */
  remember(from: string, ref: DelegationRef) {
    return this.serial(async () => {
      this.data.known = [...this.data.known.filter((k) => k.taskId !== ref.taskId), { ...ref, from }].slice(-MAX_ENTRIES);
    });
  }

  /** Delegations that are waiting, as caller → colleague edges for the loop check. */
  edges(): Array<[string, string]> {
    return this.data.queued.filter((q) => q.state === 'waiting').map((q) => [q.from, q.to]);
  }

  has(id: string) {
    return this.data.queued.some((q) => q.id === id);
  }

  /** Queue a task behind earlier ones. Throws if a predecessor is not one of the caller's own delegations. */
  add(input: { from: string; to: string; input: SendTaskInput; after: string[]; callerTaskId?: string; requestedBy?: QueuedDelegation['requestedBy'] }): Promise<QueuedDelegation> {
    return this.serial(async () => {
      const ids = [...new Set(input.after)];
      if (!ids.length || ids.length > MAX_AFTER) throw new Error(`"after" needs between 1 and ${MAX_AFTER} task ids from your earlier a2a__send_task calls`);
      const refs: DelegationRef[] = ids.map((id) => {
        const known = this.data.known.find((k) => k.taskId === id && k.from === input.from);
        if (!known) throw new Error(`"${id}" is not a task you delegated: use the taskId that a2a__send_task returned`);
        return { agentId: known.agentId, taskId: id };
      });
      const q: QueuedDelegation = { id: `q-${randomBytes(6).toString('hex')}`, from: input.from, to: input.to, input: input.input, after: refs, callerTaskId: input.callerTaskId, requestedBy: input.requestedBy, at: new Date().toISOString(), state: 'waiting' };
      this.data.queued.push(q);
      this.data.known = [...this.data.known, { agentId: input.to, taskId: q.id, from: input.from }].slice(-MAX_ENTRIES);
      if (this.data.queued.length > MAX_ENTRIES) this.data.queued = this.data.queued.filter((x) => x.state === 'waiting').concat(this.data.queued.filter((x) => x.state !== 'waiting').slice(-100));
      return q;
    });
  }

  /** Status of a delegation by id (queue ids and, through them, real ones); advances the queue as a side effect. */
  status(id: string): Promise<DelegationStatus> {
    return this.serial(() => this.statusOf(id, new Set()));
  }

  private async statusOfRef(ref: DelegationRef, from: string, seen: Set<string>): Promise<DelegationStatus> {
    return isQueueId(ref.taskId) ? this.statusOf(ref.taskId, seen) : this.deps.remoteStatus(from, ref);
  }

  private async statusOf(id: string, seen: Set<string>): Promise<DelegationStatus> {
    const q = this.data.queued.find((x) => x.id === id);
    if (!q) return { agentId: 'unknown', taskId: id, state: 'unknown', terminal: true, summary: 'unknown queued delegation' };
    if (seen.has(id)) return { agentId: q.to, taskId: id, state: 'canceled', terminal: true, summary: 'circular dependency' };
    seen.add(id);
    const view = (s: Pick<DelegationStatus, 'state' | 'terminal'> & Partial<DelegationStatus>): DelegationStatus => ({ ...s, agentId: q.to, taskId: q.id });

    if (q.state === 'waiting') {
      const results: Array<{ ref: DelegationRef; status: DelegationStatus }> = [];
      for (const ref of q.after) results.push({ ref, status: await this.statusOfRef(ref, q.from, new Set(seen)) });
      const failed = results.find((r) => r.status.terminal && r.status.state !== 'completed');
      if (failed) {
        Object.assign(q, { state: 'canceled', reason: `Not started: the task it depends on (${failed.ref.agentId}) ended as ${failed.status.state}${failed.status.summary ? `: ${failed.status.summary.slice(0, 200)}` : ''}` });
      } else if (results.every((r) => r.status.state === 'completed')) {
        const why = await this.deps.blocked(q);
        if (why) Object.assign(q, { state: 'canceled', reason: `Not started: ${why}` });
        else {
          const sent = await this.deps.dispatch(q, withResults(q.input.instructions, results));
          Object.assign(q, { state: 'dispatched', remoteTaskId: sent.taskId });
          this.data.known = [...this.data.known, { agentId: q.to, taskId: sent.taskId, from: q.from }].slice(-MAX_ENTRIES);
        }
      }
    }
    if (q.state === 'waiting') return view({ state: 'submitted', terminal: false, summary: `Waiting for ${q.after.map((a) => a.agentId).join(', ')} to finish first` });
    if (q.state === 'canceled') return view({ state: 'canceled', terminal: true, summary: q.reason });
    return { ...(await this.deps.remoteStatus(q.from, { agentId: q.to, taskId: q.remoteTaskId! })), agentId: q.to, taskId: q.id };
  }
}

/** The instructions of a dependent task, with the results of what it depends on. */
export function withResults(instructions: string, results: Array<{ ref: DelegationRef; status: DelegationStatus }>): string {
  const blocks = results.map(({ ref, status }) => `### Result of ${ref.agentId}\n${(status.result ?? status.summary ?? '(no result text)').slice(0, MAX_RESULT)}`);
  return `${instructions}\n\n## Results of the tasks this work depends on (they are finished; use their facts, not your own assumptions)\n\n${blocks.join('\n\n')}`;
}
