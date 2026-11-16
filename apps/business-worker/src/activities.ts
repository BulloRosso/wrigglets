import { ApplicationFailure } from '@temporalio/common';
import type { BusinessActivities, PlaybookActivities } from '@cw/business-workflows';

/*
 * Activities of the business worker. Every write is an ontology action (POST /actions/:name on the ontology server,
 * internal token): validated, policy-checked, audited, an event. Business refusals (422/403) are results, not errors,
 * so they are not retried; transport errors and 5xx are retried by Temporal.
 */

export function createActivities(o: { ontologyUrl: string; token: string; fetchImpl?: typeof fetch }): BusinessActivities {
  const f = o.fetchImpl ?? fetch;
  const base = o.ontologyUrl.replace(/\/$/, '');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${base}${path}`, { method, headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  };
  return {
    async runAction({ action, args, caller }) {
      const body = { ...args, ...(caller.agent ? { _agent: caller.agent } : {}), ...(caller.user ? { _requestedBy: caller.user } : {}), ...(caller.task ? { _task: caller.task } : {}), ...(caller.workflow ? { _workflow: caller.workflow } : {}), ...(caller.approvedBy ? { _approvedBy: caller.approvedBy } : {}) };
      const { status, json } = await call('POST', `/actions/${encodeURIComponent(action)}`, body);
      if (status >= 500) throw new Error(`ontology server ${status}: ${String(json.error ?? '')}`);
      if (status === 401) throw ApplicationFailure.nonRetryable('ontology server rejected the worker token');
      return { ok: status === 200 && json.ok === true, result: String(json.result ?? json.error ?? `HTTP ${status}`), seq: typeof json.seq === 'number' ? json.seq : undefined };
    },
    async getObject({ cls, id }) {
      const { status, json } = await call('GET', `/objects/${encodeURIComponent(cls)}/${encodeURIComponent(id)}`);
      if (status === 404) return null;
      if (status >= 400) throw new Error(`ontology server ${status}`);
      return json;
    },
    async flushLake() {
      const { status, json } = await call('POST', '/internal/lake/flush');
      if (status >= 400) throw new Error(`lake flush failed: ${status} ${String(json.error ?? '')}`);
      return { flushed: Number(json.flushed ?? 0), hwm: Number(json.hwm ?? 0) };
    },
    async notify({ kind, subject, body, ref }) {
      // recorded as an event (no changes: not business data); mail delivery can subscribe to it later
      await call('POST', '/internal/events', { events: [{ type: 'BusinessNotification', objectType: 'Notification', objectId: ref, payload: { kind, subject, body } }] });
    },
  };
}

/** Playbook activities (ADR-0047): the control plane assesses the blast radius and executes the steps. */
export function createPlaybookActivities(o: { controlPlaneUrl: string; token: string; fetchImpl?: typeof fetch }): PlaybookActivities {
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
