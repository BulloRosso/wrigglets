import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/*
 * Event log as the one source of truth (ADR-0049): while Liquid Enterprise is installed, the platform's separate audit
 * trails are forwarded into the event log as event types — admin actions (AdminAction), the gateway's tool calls and
 * policy decisions (GatewayToolCall), the agents' application audit (AgentAppAction). Audit is then a query over the
 * event log, with one retention rule. The original files stay as the local buffer of each component (and keep working
 * without Liquid).
 *
 * Polling with persisted cursors (restart-safe) and deterministic event ids (idempotent: a re-sent entry is not
 * appended twice). Order within a source is kept; the original time becomes the event's occurred_at.
 */

export interface FeedEvent {
  eventId: string;
  type: string;
  objectType: string;
  objectId: string;
  actorAgent?: string;
  actorUser?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface FeedSources {
  /** Admin audit entries, newest first (AdminAudit.list). */
  adminAudit(): Promise<Array<{ at: string; by: string; action: string; target: string; details?: Record<string, unknown> }>>;
  /** The gateway's recent tool calls (newest last or first; sorted here). */
  gatewayAudit(): Promise<Array<Record<string, unknown> & { at: string; agentId: string; tool: string; outcome: string }> | undefined>;
  /** Agents and a way to read their application audit since a time. */
  agents(): string[];
  agentAudit(agentId: string, since: string): Promise<Array<{ at: string; by: string; action: string; target: string; details?: Record<string, unknown> }> | undefined>;
  /** Appends events to the event log (enterprise core /internal/events). */
  append(events: FeedEvent[]): Promise<void>;
  enabled(): boolean;
}

/** A UUID derived from the content (v5-like): the same entry always gets the same event id. */
export function eventIdOf(...parts: unknown[]): string {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const agentType = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').replace(/^./, (c) => c.toUpperCase()) || 'Target';

export class EventFeed {
  private cursor: { start: string; admin: string; gateway: string; agents: Record<string, string> } = { start: '', admin: '', gateway: '', agents: {} };
  private readonly file: string;
  private running = false;
  last?: { at: string; forwarded: number; error?: string };

  constructor(
    dataDir: string,
    private readonly src: FeedSources,
  ) {
    this.file = path.join(dataDir, 'liquid', 'event-feed.json');
  }

  /** Uninstall with delete data: forward from now on; written to disk only by the next run (when installed again). */
  reset() {
    const now = new Date().toISOString();
    this.cursor = { start: now, admin: now, gateway: now, agents: {} };
    this.last = undefined;
  }

  async load() {
    try {
      this.cursor = { ...this.cursor, ...(JSON.parse(await readFile(this.file, 'utf8')) as typeof this.cursor) };
    } catch {
      // first start: forward from now on (history stays in the files)
      const now = new Date().toISOString();
      this.cursor = { start: now, admin: now, gateway: now, agents: {} };
      await this.persist();
    }
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.cursor));
    await rename(`${this.file}.tmp`, this.file);
  }

  /** One pass over all sources; each source advances its cursor only after its events were appended. */
  async tick(): Promise<number> {
    if (this.running || !this.src.enabled()) return 0;
    this.running = true;
    let n = 0;
    try {
      const admin = (await this.src.adminAudit()).filter((e) => e.at > this.cursor.admin).sort((a, b) => a.at.localeCompare(b.at));
      if (admin.length) {
        await this.src.append(admin.map((e) => ({ eventId: eventIdOf('admin', e), type: 'AdminAction', objectType: agentType(e.action.split('.')[0] ?? 'Admin'), objectId: e.target || '-', actorUser: e.by, occurredAt: e.at, payload: { action: e.action, target: e.target, details: e.details ?? null } })));
        this.cursor.admin = admin.at(-1)!.at;
        n += admin.length;
      }
      const gw = ((await this.src.gatewayAudit().catch(() => undefined)) ?? []).filter((e) => e.at > this.cursor.gateway).sort((a, b) => a.at.localeCompare(b.at));
      if (gw.length) {
        await this.src.append(gw.map((e) => ({ eventId: eventIdOf('gateway', e), type: 'GatewayToolCall', objectType: 'Tool', objectId: e.tool, actorAgent: e.agentId, occurredAt: e.at, payload: { ...e } })));
        this.cursor.gateway = gw.at(-1)!.at;
        n += gw.length;
      }
      for (const agent of this.src.agents()) {
        // an agent seen for the first time is read from the start of the feed
        const since = this.cursor.agents[agent] ?? this.cursor.start;
        const entries = ((await this.src.agentAudit(agent, since).catch(() => undefined)) ?? []).filter((e) => e.at > since);
        if (!entries.length) continue;
        await this.src.append(entries.map((e) => ({ eventId: eventIdOf('agent', agent, e), type: 'AgentAppAction', objectType: 'Agent', objectId: agent, actorAgent: agent, actorUser: e.by, occurredAt: e.at, payload: { action: e.action, target: e.target, details: e.details ?? null } })));
        this.cursor.agents[agent] = entries.at(-1)!.at;
        n += entries.length;
      }
      await this.persist();
      this.last = { at: new Date().toISOString(), forwarded: n };
    } catch (err) {
      await this.persist().catch(() => undefined);
      this.last = { at: new Date().toISOString(), forwarded: n, error: String(err) };
      throw err; // the job runner records it (health view); the cursor keeps what was forwarded
    } finally {
      this.running = false;
    }
    return n;
  }

}
