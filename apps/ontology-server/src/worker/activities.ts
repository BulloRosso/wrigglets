import { ApplicationFailure } from '@temporalio/common';
import type { BusinessActivities, PlaybookActivities } from '@cw/business-workflows';
import type { EventStore, Lake } from '@cw/lake';
import { identifierIn } from '../runtime.js';
import { OntologyService } from '../service.js';

/*
 * Activities of the business workflows, inside the enterprise core (ADR-0049: ontology server and business worker are
 * one process). Every write is still an ontology action through the action pipeline — validated, policy-checked,
 * an event — only without an HTTP hop to itself. Business refusals are results (not retried); unexpected errors throw
 * (Temporal retries).
 */

export function coreActivities(o: { svc: OntologyService; store: EventStore; lake: Lake; flushGraceMs: number }): BusinessActivities {
  return {
    async runAction({ action, args, caller }) {
      const out = await o.svc.execute(action, args, { agent: caller.agent, user: caller.user, task: caller.task, workflow: caller.workflow, approvedBy: caller.approvedBy });
      return { ok: !out.isError, result: out.text, seq: out.seq };
    },
    async getObject({ cls, id }) {
      const row = (o.svc.objects()[cls] ?? []).find((r) => String(r[identifierIn(o.svc.ir, cls)]) === String(id));
      return row ? { ...row } : null;
    },
    async flushLake() {
      const r = await o.lake.flush(o.store, { graceMs: o.flushGraceMs });
      return { flushed: Number((r as { flushed?: number }).flushed ?? 0), hwm: Number((r as { hwm?: number }).hwm ?? 0) };
    },
    async notify({ kind, subject, body, ref }) {
      await o.store.append([{ type: 'BusinessNotification', objectType: 'Notification', objectId: ref, payload: { kind, subject, body } }]);
    },
  };
}

/** Playbook activities: the control plane assesses the blast radius and executes the steps (it owns gateway, overlays, kill switch). */
export function playbookActivities(o: { controlPlaneUrl: string; token: string; fetchImpl?: typeof fetch }): PlaybookActivities {
  const f = o.fetchImpl ?? fetch;
  const base = o.controlPlaneUrl.replace(/\/$/, '');
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await f(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
    if (res.status === 401) throw ApplicationFailure.nonRetryable('control plane rejected the playbook token');
    if (!res.ok) throw new Error(`control plane ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  };
  return {
    assessBlast: ({ trigger }) => post('/internal/liquid/playbooks/assess', { trigger }),
    executeStep: (i) => post('/internal/liquid/playbooks/execute', i),
    recordRun: async (i) => void (await post('/internal/liquid/playbooks/record', i)),
  };
}
