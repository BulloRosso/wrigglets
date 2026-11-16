import { BSA, objectRef, type ApprovalInput, type PurchaseOrderReleaseInput } from '@cw/business-workflows';

/*
 * Dispatcher (ADR-0045, outbox pattern): the action pipeline commits an event; the dispatcher reads committed events in
 * seq order and starts or signals business workflows. Workflow ids are derived from the event id, so a start is
 * idempotent (Temporal refuses a second start with the same id) and a restart never starts twice.
 *   - an action with `starts_workflow` (ontology) → start that workflow
 *   - an action with `signals_workflow` → signal the running workflows of the action's object
 *   - ActionApprovalRequested (four eyes, ADR-0044) → start an ApprovalWorkflow
 */

export interface DispatchEvent {
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
}

export interface IrActionLite {
  name: string;
  target?: string;
  startsWorkflow?: string;
  signalsWorkflow?: { workflow: string; signal: string };
  input: Array<{ name: string; range: string; rangeKind: string; multivalued: boolean }>;
}

export interface DispatchConfig {
  today: string;
  msPerSimDay: number;
  releaseAfterMs: number;
  approvalReminderMs: number;
  approvalExpireMs: number;
}

export type Command =
  | { kind: 'start'; workflowType: string; workflowId: string; args: unknown[]; objects: string[] }
  | { kind: 'signal'; workflowType: string; query: string; signal: string; payload: unknown };

type Row = Record<string, unknown>;
const changeOf = (e: DispatchEvent, cls: string, id: string): Row | undefined =>
  ((e.payload.changes as Array<{ class: string; id: string; after: Row | null }> | undefined) ?? []).find((c) => c.class === cls && c.id === id)?.after ?? undefined;

/** Ontology object refs an action call touches (class-typed inputs), e.g. Supplier:S-BALTIC. */
export function objectsOf(action: IrActionLite | undefined, args: Record<string, unknown>): string[] {
  if (!action) return [];
  return action.input.filter((f) => f.rangeKind === 'class').flatMap((f) => {
    const v = args[f.name];
    return (Array.isArray(v) ? v : v == null ? [] : [v]).map((id) => objectRef(f.range, String(id)));
  });
}

const q = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function commandsFor(e: DispatchEvent, actions: Map<string, IrActionLite>, cfg: DispatchConfig): Command[] {
  const out: Command[] = [];
  if (e.type === 'ActionApprovalRequested' && e.action) {
    const args = (e.payload.input as Record<string, unknown>) ?? {};
    const input: ApprovalInput = {
      requestSeq: e.seq,
      action: e.action,
      args,
      caller: { agent: e.actorAgent ?? undefined, user: e.actorUser ?? undefined, task: e.taskId ?? undefined },
      target: e.objectType !== 'Company' ? e.objectType : undefined,
      reason: (e.payload.reason as string | null) ?? undefined,
      objects: objectsOf(actions.get(e.action), args),
      reminderMs: cfg.approvalReminderMs,
      expireMs: cfg.approvalExpireMs,
    };
    out.push({ kind: 'start', workflowType: 'ApprovalWorkflow', workflowId: `ApprovalWorkflow-${e.eventId}`, args: [input], objects: input.objects });
    return out;
  }
  const a = e.action ? actions.get(e.action) : undefined;
  if (!a || !('changes' in e.payload)) return out;
  if (a.startsWorkflow === 'PurchaseOrderRelease') {
    const po = changeOf(e, 'PurchaseOrder', e.objectId);
    if (po) {
      const input: PurchaseOrderReleaseInput = { poId: e.objectId, supplierId: String(po.supplier), sku: String(po.sku), qty: Number(po.qty), eta: String(po.eta), today: cfg.today, msPerSimDay: cfg.msPerSimDay, releaseAfterMs: cfg.releaseAfterMs, eventSeq: e.seq };
      out.push({ kind: 'start', workflowType: 'PurchaseOrderRelease', workflowId: `PurchaseOrderRelease-${e.eventId}`, args: [input], objects: [objectRef('PurchaseOrder', input.poId), objectRef('Supplier', input.supplierId), objectRef('Material', input.sku)] });
    }
  } else if (a.startsWorkflow) {
    out.push({ kind: 'start', workflowType: a.startsWorkflow, workflowId: `${a.startsWorkflow}-${e.eventId}`, args: [{ event: e }], objects: [objectRef(e.objectType, e.objectId)] });
  }
  if (a.signalsWorkflow && a.target) {
    out.push({
      kind: 'signal',
      workflowType: a.signalsWorkflow.workflow,
      query: `WorkflowType = ${q(a.signalsWorkflow.workflow)} AND ${BSA.OntologyObjects.name} = ${q(objectRef(a.target, e.objectId))} AND ExecutionStatus = 'Running'`,
      signal: a.signalsWorkflow.signal,
      payload: { reason: `${e.action} (event ${e.seq})` },
    });
  }
  return out;
}
