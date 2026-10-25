import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils.js';
import type { TimelineMarker, TimelineSpan } from '@cw/shared';
import { decodeHistory, normalizeEventType } from '../src/timeline/history.js';
import { mapHistory, mergeTimelines } from '../src/timeline/mapHistory.js';

/* Fixtures are real histories recorded by packages/workflows tests (RECORD_HISTORIES=1). */
const fixture = async (name: string) => {
  const file = fileURLToPath(new URL(`../../../packages/workflows/test/histories/${name}.json`, import.meta.url));
  const { workflowId, history } = JSON.parse(readFileSync(file, 'utf8')) as { workflowId: string; history: unknown };
  return { workflowId, events: await decodeHistory(historyFromJSON(history)) };
};
const spans = (items: Array<TimelineSpan | TimelineMarker>) => items.filter((i): i is TimelineSpan => i.type === 'span');
const markers = (items: Array<TimelineSpan | TimelineMarker>) => items.filter((i): i is TimelineMarker => i.type === 'marker');

describe('mapHistory', () => {
  it('normalizes event type names', () => {
    expect(normalizeEventType('EVENT_TYPE_WORKFLOW_EXECUTION_STARTED')).toBe('WorkflowExecutionStarted');
    expect(normalizeEventType('ActivityTaskScheduled')).toBe('ActivityTaskScheduled');
  });

  it('maps the happy path: requested → plan → approval → run → verify → finalize → completed', async () => {
    const { workflowId, events } = await fixture('happy-path');
    const tl = mapHistory(events, { laneId: workflowId });
    expect(tl.lanes[0]).toMatchObject({ id: workflowId, label: 'Evaluate offers', kind: 'task', status: 'completed' });
    expect(spans(tl.items).map((s) => s.category)).toEqual(['plan', 'wait-approval', 'run', 'verify', 'finalize']);
    expect(spans(tl.items).every((s) => s.end && s.status === 'ok')).toBe(true);
    const m = markers(tl.items);
    expect(m.map((x) => x.category)).toEqual(['requested', 'approved', 'completed']);
    expect(m[0]!.by).toEqual({ upn: 'anna@example.com', name: 'Anna' });
    expect(m[1]).toMatchObject({ by: { upn: 'ben@example.com', name: 'Ben' }, text: 'Weight delivery times higher' });
    const plan = spans(tl.items)[0]!;
    expect(plan.label).toMatch(/^Plan #1/);
    expect(plan.details?.commit).toBe(`c-${workflowId}:plan:1`);
  });

  it('marks failed verification rounds and fix steps', async () => {
    const { workflowId, events } = await fixture('verify-failed');
    const tl = mapHistory(events, { laneId: workflowId });
    const s = spans(tl.items);
    expect(s.map((x) => x.category)).toEqual(['plan', 'run', 'verify', 'fix', 'verify', 'fix', 'verify', 'finalize']);
    expect(s.filter((x) => x.category === 'verify').every((x) => x.status === 'failed')).toBe(true);
    expect(markers(tl.items).at(-1)).toMatchObject({ category: 'failed' });
  });

  it('shows reminders and expiry', async () => {
    const { workflowId, events } = await fixture('expired');
    const tl = mapHistory(events, { laneId: workflowId });
    expect(markers(tl.items).map((x) => x.category)).toEqual(['requested', 'reminder', 'failed']);
    expect(spans(tl.items).find((x) => x.category === 'wait-approval')).toMatchObject({ status: 'failed' });
    expect(markers(tl.items).at(-1)!.label).toBe('Approval expired');
  });

  it('records rejection with comment and cancellation by whom', async () => {
    const rejected = await fixture('rejected-plan');
    expect(markers(mapHistory(rejected.events, { laneId: rejected.workflowId }).items).map((x) => x.category)).toEqual(['requested', 'rejected', 'rejected']);
    const cancelled = await fixture('cancelled');
    const tl = mapHistory(cancelled.events, { laneId: cancelled.workflowId });
    expect(markers(tl.items).find((x) => x.label === 'Cancellation requested')).toMatchObject({ by: { upn: 'anna@example.com' }, text: 'changed my mind' });
    expect(spans(tl.items).find((x) => x.category === 'run')).toMatchObject({ status: 'failed' });
  });

  it('adds an agent lane with the lock-holding spans when merging', async () => {
    const a = await fixture('happy-path');
    const b = await fixture('budget-exceeded');
    const merged = mergeTimelines([mapHistory(a.events, { laneId: a.workflowId }), mapHistory(b.events, { laneId: b.workflowId })], { id: 'agent-x', label: 'X' });
    expect(merged.lanes.map((l) => l.kind)).toEqual(['agent', 'task', 'task']);
    const agentSpans = merged.items.filter((i) => i.lane === 'agent-x');
    expect(agentSpans.length).toBeGreaterThan(4);
    expect(agentSpans.every((i) => i.type === 'span' && i.category !== 'wait-approval')).toBe(true);
  });
});
