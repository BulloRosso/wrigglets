import type {
  Identity,
  SpanCategory,
  TaskInput,
  TaskResult,
  Timeline,
  TimelineItem,
  TimelineMarker,
  TimelineSpan,
} from '@cw/shared';
import type { HistoryEventJson } from './history.js';

/*
 * Event History → activity timeline (spec §10). Pure function, unit-tested with fixtures.
 * Input: decoded history events (payloads already replaced by their values).
 */

export interface MapOptions {
  laneId: string;
  laneLabel?: string;
  /** Minimum duration for lock waits to be shown (spec: > 5 s). */
  minLockWaitMs?: number;
}

type Attr = Record<string, any>;
const attrs = (e: HistoryEventJson, name: string): Attr => (e[`${name}EventAttributes`] as Attr | undefined) ?? {};
const firstPayload = (p: unknown): any => (p as { payloads?: unknown[] } | undefined)?.payloads?.[0];
const who = (i?: Identity | { upn: string; name: string }) => (i ? { upn: i.upn, name: i.name } : undefined);

const ACTIVITY_CATEGORY: Record<string, SpanCategory | undefined> = {
  verify: 'verify',
  finalizeTask: 'finalize',
  applyUpload: 'upload',
  gitMaintenance: 'maintenance',
  backupWorkspace: 'maintenance',
  cleanupArtifacts: 'maintenance',
};

const DECISION_MARKER = { approve: 'approved', reject: 'rejected', revise: 'revise' } as const;

export function mapHistory(events: HistoryEventJson[], opts: MapOptions): Timeline {
  const lane = opts.laneId;
  const minLockWait = opts.minLockWaitMs ?? 5000;
  const items: TimelineItem[] = [];
  const byId = new Map<string, HistoryEventJson>();
  for (const e of events) byId.set(String(e.eventId), e);

  let input: TaskInput | undefined;
  const openActivities = new Map<string, TimelineSpan>();
  let lockWaitStart: string | undefined;
  let approvalStart: string | undefined;
  let status: string | undefined;
  let lockWaits = 0;

  const closeApproval = (at: string, ok: boolean) => {
    if (!approvalStart) return;
    items.push({ type: 'span', lane, id: `${lane}:wait-approval:${approvalStart}`, category: 'wait-approval', label: 'Waiting for approval', start: approvalStart, end: at, status: ok ? 'ok' : 'failed' });
    approvalStart = undefined;
  };

  for (const e of events) {
    const at = e.eventTime;
    switch (e.eventType) {
      case 'WorkflowExecutionStarted': {
        input = firstPayload(attrs(e, 'workflowExecutionStarted').input) as TaskInput | undefined;
        const by = input?.trigger?.kind === 'schedule' ? input.trigger.owner : input?.requestedBy;
        items.push({
          type: 'marker',
          lane,
          id: `${lane}:requested`,
          category: 'requested',
          label: input?.trigger?.kind === 'schedule' ? `Scheduled run (${input.trigger.scheduleId})` : 'Requested',
          at,
          by: who(by),
          text: input?.title,
        });
        break;
      }
      case 'ActivityTaskScheduled': {
        const a = attrs(e, 'activityTaskScheduled');
        const type: string = a.activityType?.name ?? 'activity';
        const actInput = firstPayload(a.input) as Record<string, any> | undefined;
        if (type === 'notify') {
          if (actInput?.kind === 'approval_reminder') {
            items.push({ type: 'marker', lane, id: `${lane}:reminder:${e.eventId}`, category: 'reminder', label: 'Approval reminder sent', at });
          }
          break;
        }
        const category: SpanCategory | undefined = type === 'runAgentStep' ? (actInput?.kind as SpanCategory) : ACTIVITY_CATEGORY[type];
        if (!category) break;
        const summary = (e.userMetadata?.summary as string | undefined) ?? actInput?.summary ?? type;
        const span: TimelineSpan = { type: 'span', lane, id: `${lane}:act:${e.eventId}`, category, label: summary, start: at, status: 'running' };
        openActivities.set(String(e.eventId), span);
        items.push(span);
        break;
      }
      case 'ActivityTaskStarted': {
        const a = attrs(e, 'activityTaskStarted');
        const span = openActivities.get(String(a.scheduledEventId));
        if (span) span.attempt = Number(a.attempt ?? 1);
        break;
      }
      case 'ActivityTaskCompleted': {
        const a = attrs(e, 'activityTaskCompleted');
        const span = openActivities.get(String(a.scheduledEventId));
        if (!span) break;
        const result = firstPayload(a.result) as Record<string, any> | undefined;
        span.end = at;
        span.status = (span.attempt ?? 1) > 1 ? 'retried' : 'ok';
        if (result) {
          span.details = {
            summary: result.summary ?? (result.ok === false ? 'verification failed' : undefined),
            commit: result.commit ?? result.finalCommit,
            tokens: result.tokens,
            artifacts: result.artifacts ?? (result.reportPath ? [result.reportPath] : undefined),
          };
          if (span.category === 'verify' && result.ok === false) span.status = 'failed';
        }
        openActivities.delete(String(a.scheduledEventId));
        break;
      }
      case 'ActivityTaskFailed':
      case 'ActivityTaskTimedOut':
      case 'ActivityTaskCanceled': {
        const name = e.eventType === 'ActivityTaskFailed' ? 'activityTaskFailed' : e.eventType === 'ActivityTaskTimedOut' ? 'activityTaskTimedOut' : 'activityTaskCanceled';
        const a = attrs(e, name);
        const span = openActivities.get(String(a.scheduledEventId));
        if (!span) break;
        span.end = at;
        span.status = 'failed';
        span.details = { ...span.details, error: a.failure?.message ?? (e.eventType === 'ActivityTaskCanceled' ? 'cancelled' : 'timed out') };
        openActivities.delete(String(a.scheduledEventId));
        break;
      }
      case 'SignalExternalWorkflowExecutionInitiated': {
        const a = attrs(e, 'signalExternalWorkflowExecutionInitiated');
        if (a.signalName === 'acquire') lockWaitStart = at;
        if (a.signalName === 'release' && lockWaitStart) lockWaitStart = undefined; // cancelled while waiting
        break;
      }
      case 'WorkflowExecutionSignaled': {
        const a = attrs(e, 'workflowExecutionSignaled');
        if (a.signalName === 'granted' && lockWaitStart) {
          const ms = Date.parse(at) - Date.parse(lockWaitStart);
          if (ms > minLockWait) {
            items.push({ type: 'span', lane, id: `${lane}:wait-lock:${lockWaits++}`, category: 'wait-lock', label: `Waiting for workspace (${Math.round(ms / 1000)} s)`, start: lockWaitStart, end: at, status: 'ok' });
          }
          lockWaitStart = undefined;
        }
        break;
      }
      case 'UpsertWorkflowSearchAttributes': {
        const fields = attrs(e, 'upsertWorkflowSearchAttributes').searchAttributes?.indexedFields ?? {};
        if (typeof fields.TaskStatus === 'string') {
          status = fields.TaskStatus;
          if (status === 'awaiting_approval') approvalStart = at;
        }
        break;
      }
      case 'WorkflowExecutionUpdateAccepted': {
        const a = attrs(e, 'workflowExecutionUpdateAccepted');
        const name: string | undefined = a.acceptedRequest?.input?.name;
        const arg = firstPayload(a.acceptedRequest?.input?.args) as Record<string, any> | undefined;
        if (name === 'decide' && arg) {
          const category = DECISION_MARKER[arg.decision as keyof typeof DECISION_MARKER] ?? 'comment';
          closeApproval(at, true);
          items.push({ type: 'marker', lane, id: `${lane}:decision:${e.eventId}`, category, label: category === 'approved' ? 'Approved' : category === 'rejected' ? 'Rejected' : 'Changes requested', at, by: who(arg.by), text: arg.comment });
        } else if (name === 'comment' && arg) {
          items.push({ type: 'marker', lane, id: `${lane}:comment:${e.eventId}`, category: 'comment', label: 'Comment', at, by: who(arg.by), text: String(arg.text ?? '').slice(0, 500) });
        } else if (name === 'cancel' && arg) {
          closeApproval(at, false);
          items.push({ type: 'marker', lane, id: `${lane}:cancel:${e.eventId}`, category: 'cancelled', label: 'Cancellation requested', at, by: who(arg.by), text: arg.reason });
        }
        break;
      }
      case 'WorkflowExecutionCompleted': {
        const result = firstPayload(attrs(e, 'workflowExecutionCompleted').result) as TaskResult | undefined;
        const s = result?.status ?? 'completed';
        closeApproval(at, s === 'completed');
        const category = s === 'completed' ? 'completed' : s === 'cancelled' ? 'cancelled' : s === 'rejected' ? 'rejected' : 'failed';
        items.push({ type: 'marker', lane, id: `${lane}:closed`, category, label: LABEL[s] ?? s, at, text: result?.error });
        break;
      }
      case 'WorkflowExecutionFailed':
      case 'WorkflowExecutionTimedOut':
      case 'WorkflowExecutionTerminated': {
        closeApproval(at, false);
        const a = attrs(e, e.eventType === 'WorkflowExecutionFailed' ? 'workflowExecutionFailed' : e.eventType === 'WorkflowExecutionTerminated' ? 'workflowExecutionTerminated' : 'workflowExecutionTimedOut');
        items.push({ type: 'marker', lane, id: `${lane}:closed`, category: 'failed', label: e.eventType.replace('WorkflowExecution', ''), at, text: a.failure?.message ?? a.reason });
        break;
      }
      case 'WorkflowExecutionCanceled': {
        closeApproval(at, false);
        items.push({ type: 'marker', lane, id: `${lane}:closed`, category: 'cancelled', label: 'Cancelled', at });
        break;
      }
      default:
        break;
    }
  }

  // Still waiting (running workflow): open spans without `end`.
  if (lockWaitStart) {
    items.push({ type: 'span', lane, id: `${lane}:wait-lock:${lockWaits}`, category: 'wait-lock', label: 'Waiting for workspace', start: lockWaitStart, status: 'running' });
  }
  if (approvalStart) {
    items.push({ type: 'span', lane, id: `${lane}:wait-approval:${approvalStart}`, category: 'wait-approval', label: 'Waiting for approval', start: approvalStart, status: 'running' });
  }

  items.sort((a, b) => Date.parse(start(a)) - Date.parse(start(b)));
  return {
    lanes: [{ id: lane, label: opts.laneLabel ?? input?.title ?? lane, kind: 'task', status }],
    items,
  };
}

const start = (i: TimelineItem) => (i.type === 'span' ? i.start : (i as TimelineMarker).at);

const LABEL: Record<string, string> = {
  completed: 'Completed',
  failed: 'Failed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  budget_exceeded: 'Budget exceeded',
  expired: 'Approval expired',
};

/** Merges several task timelines and adds an "agent" lane showing when the workspace lock was used. */
export function mergeTimelines(timelines: Timeline[], agentLane: { id: string; label: string }): Timeline {
  const lockCategories = new Set<SpanCategory>(['plan', 'run', 'fix', 'verify', 'finalize', 'upload', 'maintenance']);
  const lanes = [{ ...agentLane, kind: 'agent' as const }, ...timelines.flatMap((t) => t.lanes)];
  const items: TimelineItem[] = [];
  for (const t of timelines) {
    for (const i of t.items) {
      items.push(i);
      if (i.type === 'span' && lockCategories.has(i.category)) {
        const taskLane = t.lanes[0];
        items.push({ ...i, lane: agentLane.id, id: `${agentLane.id}:${i.id}`, label: `${taskLane?.label ?? i.lane}: ${i.label}` });
      }
    }
  }
  return { lanes, items };
}
