import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/*
 * Append-only event log (ADR-0040) in the ontology database. Every change to business data is an event; the projection
 * (M3) is a cache rebuilt from it. Appends are idempotent by event_id. UPDATE, DELETE and TRUNCATE are rejected by a
 * trigger, for every role, so corrections are always new events.
 */

/** What the store needs from a Postgres client; satisfied by pg.Pool and by PGlite (tests). */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const id = z.string().trim().min(1).max(200);

export const eventInput = z.object({
  eventId: z.uuid().optional(),
  /** PascalCase event type, e.g. PurchaseOrderCreated, SupplierNoticeIssued. */
  type: z.string().regex(/^[A-Z][A-Za-z0-9]{1,80}$/),
  objectType: z.string().regex(/^[A-Z][A-Za-z0-9]{1,80}$/),
  objectId: id,
  action: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/).optional(),
  actorAgent: id.optional(),
  actorUser: id.optional(),
  taskId: id.optional(),
  workflowId: id.optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  ontologyVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('0.0.0'),
});
export type EventInput = z.input<typeof eventInput>;

export interface StoredEvent {
  seq: number;
  eventId: string;
  type: string;
  objectType: string;
  objectId: string;
  action: string | null;
  actorAgent: string | null;
  actorUser: string | null;
  taskId: string | null;
  workflowId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
  ontologyVersion: string;
}

export const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq              bigserial PRIMARY KEY,
  event_id         uuid NOT NULL UNIQUE,
  type             text NOT NULL,
  object_type      text NOT NULL,
  object_id        text NOT NULL,
  action           text,
  actor_agent      text,
  actor_user       text,
  task_id          text,
  workflow_id      text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  ontology_version text NOT NULL
);
CREATE INDEX IF NOT EXISTS events_object ON events (object_type, object_id);
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is not allowed (write a correcting event instead)', TG_OP;
END $$;
DROP TRIGGER IF EXISTS events_no_update_delete ON events;
CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();
DROP TRIGGER IF EXISTS events_no_truncate ON events;
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();
`;

const COLS = 'seq, event_id, type, object_type, object_id, action, actor_agent, actor_user, task_id, workflow_id, payload, occurred_at, recorded_at, ontology_version';

type Row = Record<string, unknown>;
const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const toEvent = (r: Row): StoredEvent => ({
  seq: Number(r.seq),
  eventId: String(r.event_id),
  type: String(r.type),
  objectType: String(r.object_type),
  objectId: String(r.object_id),
  action: (r.action as string | null) ?? null,
  actorAgent: (r.actor_agent as string | null) ?? null,
  actorUser: (r.actor_user as string | null) ?? null,
  taskId: (r.task_id as string | null) ?? null,
  workflowId: (r.workflow_id as string | null) ?? null,
  payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
  occurredAt: ts(r.occurred_at),
  recordedAt: ts(r.recorded_at),
  ontologyVersion: String(r.ontology_version),
});

export class EventStore {
  constructor(private readonly db: SqlClient) {}

  async migrate() {
    await this.db.query(EVENTS_DDL);
  }

  /**
   * Appends events in one statement (all or nothing). An event whose event_id exists already is not written again;
   * the result then carries the existing seq and `duplicate: true`.
   */
  async append(inputs: EventInput[]): Promise<Array<{ eventId: string; seq: number; duplicate: boolean }>> {
    if (!inputs.length) return [];
    const events = inputs.map((i) => {
      const e = eventInput.parse(i);
      return { ...e, eventId: e.eventId ?? randomUUID() };
    });
    const params: unknown[] = [];
    const values = events.map((e) => {
      const base = params.length;
      params.push(e.eventId, e.type, e.objectType, e.objectId, e.action ?? null, e.actorAgent ?? null, e.actorUser ?? null, e.taskId ?? null, e.workflowId ?? null, JSON.stringify(e.payload), e.occurredAt ?? null, e.ontologyVersion);
      const p = (n: number) => `$${base + n}`;
      return `(${p(1)}::uuid, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}::jsonb, coalesce(${p(11)}::timestamptz, now()), ${p(12)})`;
    });
    const inserted = await this.db.query<{ event_id: string; seq: string | number }>(
      `INSERT INTO events (event_id, type, object_type, object_id, action, actor_agent, actor_user, task_id, workflow_id, payload, occurred_at, ontology_version)
       VALUES ${values.join(', ')} ON CONFLICT (event_id) DO NOTHING RETURNING event_id, seq`,
      params,
    );
    const fresh = new Map(inserted.rows.map((r) => [String(r.event_id), Number(r.seq)]));
    const missing = events.filter((e) => !fresh.has(e.eventId)).map((e) => e.eventId);
    const existing = missing.length
      ? new Map((await this.db.query<{ event_id: string; seq: string | number }>('SELECT event_id, seq FROM events WHERE event_id = ANY($1::uuid[])', [missing])).rows.map((r) => [String(r.event_id), Number(r.seq)]))
      : new Map<string, number>();
    return events.map((e) => (fresh.has(e.eventId) ? { eventId: e.eventId, seq: fresh.get(e.eventId)!, duplicate: false } : { eventId: e.eventId, seq: existing.get(e.eventId)!, duplicate: true }));
  }

  /** Read-only query over the event log (audit, decisions): audit is a query over the event log (ADR-0049). */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query(sql, params)).rows as T[];
  }

  /** Events with seq > after, in seq order. */
  async readAfter(after: number, limit = 1000): Promise<StoredEvent[]> {
    const r = await this.db.query<Row>(`SELECT ${COLS} FROM events WHERE seq > $1 ORDER BY seq LIMIT $2`, [after, limit]);
    return r.rows.map(toEvent);
  }

  async stats(): Promise<{ count: number; maxSeq: number }> {
    const r = await this.db.query<{ n: string | number; mx: string | number | null }>('SELECT count(*) AS n, max(seq) AS mx FROM events');
    return { count: Number(r.rows[0]?.n ?? 0), maxSeq: Number(r.rows[0]?.mx ?? 0) };
  }
}

/**
 * The events that may be flushed after the high-water mark: a contiguous run of seq numbers. A gap (a seq that is not
 * visible) normally means a transaction that has not committed yet, so the batch stops there. Sequences also lose
 * numbers when inserts roll back; a gap is therefore skipped once the event after it was recorded more than `graceMs`
 * ago — by then the transaction that took the missing number has long ended.
 */
export function contiguousBatch<T extends { seq: number; recordedAt: string }>(rows: T[], hwm: number, now: number, graceMs: number): T[] {
  const out: T[] = [];
  let expected = hwm + 1;
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (r.seq < expected) continue;
    if (r.seq > expected && now - Date.parse(r.recordedAt) < graceMs) break;
    out.push(r);
    expected = r.seq + 1;
  }
  return out;
}
