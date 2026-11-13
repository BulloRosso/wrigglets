import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObservationInput } from '@cw/shared';

/*
 * Durable outbox of the signals hub. Every observation is written here BEFORE it is forwarded to the control plane, so a
 * restart, an unreachable control plane or a stopped/paused agent does not lose it. Delivery is retried with exponential
 * backoff; after `maxAgeMs` an entry moves to the failed list (visible in the admin console). References of delivered
 * observations are remembered for de-duplication (a mail fetched twice is queued once).
 */

export interface OutboxEntry {
  id: string;
  agentId: string;
  by: string;
  observation: ObservationInput;
  createdAt: string;
  attempts: number;
  nextAt: number;
  lastError?: string;
}

export interface DeliveryResult {
  /** delivered (also: a duplicate the agent already knew), retry later, or drop for good (refused). */
  outcome: 'delivered' | 'retry' | 'drop';
  error?: string;
}

export type Deliver = (e: OutboxEntry) => Promise<DeliveryResult>;

interface OutboxFile {
  pending: OutboxEntry[];
  failed: Array<OutboxEntry & { failedAt: string }>;
  delivered: string[];
}

const MAX_DELIVERED_REFS = 5_000;
const MAX_FAILED = 200;
const MAX_PENDING = 10_000;

export class Outbox {
  private data: OutboxFile = { pending: [], failed: [], delivered: [] };
  private readonly file: string;
  private writing = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private running = false;
  readonly delivered = new Map<string, number>();

  constructor(
    dataDir: string,
    private readonly deliver: Deliver,
    private readonly opts: { baseDelayMs?: number; maxDelayMs?: number; maxAgeMs?: number; now?: () => number } = {},
  ) {
    this.file = path.join(dataDir, 'outbox.json');
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  async load() {
    try {
      this.data = { pending: [], failed: [], delivered: [], ...(JSON.parse(await readFile(this.file, 'utf8')) as Partial<OutboxFile>) };
    } catch {
      this.data = { pending: [], failed: [], delivered: [] };
    }
  }

  private persist() {
    const snapshot = JSON.stringify(this.data);
    // a failed write (disk full, Windows file lock) must not break the chain for later writes
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, snapshot);
      await rename(`${this.file}.tmp`, this.file);
    });
    return this.writing;
  }

  private key(agentId: string, o: ObservationInput) {
    return o.ref ? `${agentId}|${o.source ?? 'api'}|${o.ref}` : undefined;
  }

  /** Queues an observation. Returns false if the same reference is already queued or was delivered. */
  async add(agentId: string, observation: ObservationInput, by: string): Promise<{ queued: boolean; id?: string }> {
    const key = this.key(agentId, observation);
    if (key && (this.data.delivered.includes(key) || this.data.pending.some((e) => this.key(e.agentId, e.observation) === key))) return { queued: false };
    if (this.data.pending.length >= MAX_PENDING) throw new Error('outbox is full');
    const entry: OutboxEntry = { id: randomUUID(), agentId, by, observation, createdAt: new Date(this.now()).toISOString(), attempts: 0, nextAt: this.now() };
    this.data.pending.push(entry);
    await this.persist();
    this.kick();
    return { queued: true, id: entry.id };
  }

  status() {
    const oldest = this.data.pending[0]?.createdAt;
    return { pending: this.data.pending.length, failed: this.data.failed.length, oldest };
  }

  failed() {
    return this.data.failed;
  }

  /** One delivery round over all due entries (sequential: keeps the order per agent and the load low). */
  async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const base = this.opts.baseDelayMs ?? 5_000;
      const max = this.opts.maxDelayMs ?? 15 * 60_000;
      const maxAge = this.opts.maxAgeMs ?? 7 * 86_400_000;
      for (const e of [...this.data.pending]) {
        if (e.nextAt > this.now()) continue;
        let r: DeliveryResult;
        try {
          r = await this.deliver(e);
        } catch (err) {
          r = { outcome: 'retry', error: String(err instanceof Error ? err.message : err) };
        }
        e.attempts += 1;
        const idx = this.data.pending.indexOf(e);
        if (r.outcome === 'delivered') {
          this.data.pending.splice(idx, 1);
          const key = this.key(e.agentId, e.observation);
          if (key) {
            this.data.delivered.push(key);
            if (this.data.delivered.length > MAX_DELIVERED_REFS) this.data.delivered.splice(0, this.data.delivered.length - MAX_DELIVERED_REFS);
          }
          this.delivered.set(e.agentId, (this.delivered.get(e.agentId) ?? 0) + 1);
        } else if (r.outcome === 'drop' || this.now() - Date.parse(e.createdAt) > maxAge) {
          this.data.pending.splice(idx, 1);
          this.data.failed.push({ ...e, lastError: r.error, failedAt: new Date(this.now()).toISOString() });
          if (this.data.failed.length > MAX_FAILED) this.data.failed.splice(0, this.data.failed.length - MAX_FAILED);
        } else {
          e.lastError = r.error;
          e.nextAt = this.now() + Math.min(max, base * 2 ** Math.min(e.attempts - 1, 20));
        }
        await this.persist();
      }
    } finally {
      this.running = false;
    }
  }

  /** Delivers a new entry right away once the delivery loop runs (not before `start`, e.g. in tests). */
  private kick() {
    if (this.timer) setImmediate(() => void this.flush().catch(() => undefined));
  }

  start(intervalMs = 2_000) {
    this.timer = setInterval(() => void this.flush().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
