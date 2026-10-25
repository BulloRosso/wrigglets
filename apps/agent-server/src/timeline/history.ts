import { defaultPayloadConverter, type Payload, type PayloadCodec } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import type { temporal } from '@temporalio/proto';

/** One history event in canonical proto3 JSON, with every payload replaced by its decoded value. */
export type HistoryEventJson = {
  eventId: string;
  eventTime: string;
  eventType: string;
  userMetadata?: { summary?: unknown; details?: unknown };
  [attributes: string]: unknown;
};

const isPayloadJson = (v: unknown): v is { metadata: Record<string, string>; data?: string } =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  'metadata' in v &&
  typeof (v as { metadata: unknown }).metadata === 'object' &&
  !!(v as { metadata: Record<string, unknown> }).metadata &&
  'encoding' in (v as { metadata: Record<string, unknown> }).metadata;

async function decodePayload(p: { metadata: Record<string, string>; data?: string }, codec?: PayloadCodec): Promise<unknown> {
  let payload: Payload = {
    metadata: Object.fromEntries(Object.entries(p.metadata).map(([k, v]) => [k, Buffer.from(v, 'base64')])),
    data: p.data !== undefined ? Buffer.from(p.data, 'base64') : new Uint8Array(),
  };
  try {
    if (codec) [payload] = (await codec.decode([payload])) as [Payload];
    return defaultPayloadConverter.fromPayload(payload);
  } catch (err) {
    return { $undecodable: String(err) };
  }
}

async function decodeDeep(value: unknown, codec?: PayloadCodec): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((v) => decodeDeep(v, codec)));
  if (isPayloadJson(value)) return decodePayload(value, codec);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await decodeDeep(v, codec);
    return out;
  }
  return value;
}

/** Normalizes `EVENT_TYPE_WORKFLOW_EXECUTION_STARTED` / `WorkflowExecutionStarted` to the latter. */
export function normalizeEventType(t: string): string {
  if (!t.startsWith('EVENT_TYPE_')) return t;
  return t
    .slice('EVENT_TYPE_'.length)
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

export async function decodeHistory(history: temporal.api.history.v1.IHistory, codec?: PayloadCodec): Promise<HistoryEventJson[]> {
  const json = JSON.parse(historyToJSON(history as temporal.api.history.v1.History)) as { events?: HistoryEventJson[] };
  const events = (await decodeDeep(json.events ?? [], codec)) as HistoryEventJson[];
  return events.map((e) => ({ ...e, eventType: normalizeEventType(e.eventType) }));
}
