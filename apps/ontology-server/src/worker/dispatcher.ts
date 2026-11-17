import { BSA, objectRef, type ApprovalInput, type PurchaseOrderReleaseInput } from '@cw/business-workflows';

/*
 * Dispatcher (ADR-0045, outbox pattern): the action pipeline commits an event; the dispatcher reads committed events in
 * seq order and starts or signals business workflows. Workflow ids are derived from the event id, so a start is
 * idempotent (Temporal refuses a second start with the same id) and a restart never starts twice.
 *   - an action with `starts_workflow` (ontology) → start that workflow
 *   - an action with `signals_workflow` → signal the running workflows of the action's object
 *   - ActionApprovalRequested (four eyes, ADR-0044) → start an ApprovalWorkflow
 *   - SimulationReset → cancel the running PurchaseOrderRelease workflows and withdraw pending four-eyes approvals
 *     (they belong to the old world)
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
  preconditions?: string[];
}

export interface DispatchConfig {
  today: string;
  msPerSimDay: number;
  releaseAfterMs: number;
  approvalReminderMs: number;
  approvalExpireMs: number;
  /** v2 gate of PurchaseOrderRelease (D3): re-check interval and reminder delay. */
  dueDiligencePollMs?: number;
  dueDiligenceReminderMs?: number;
}

export type Command =
  | { kind: 'start'; workflowType: string; workflowId: string; args: unknown[]; objects: string[] }
  | { kind: 'signal'; workflowType: string; query: string; signal: string; payload: unknown; /** only workflow ids matching this pattern */ idPattern?: string };

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
  // a simulation reset replaces the world: release workflows of the old one must not release the new orders that
  // get the same ids (PO numbering restarts) — they are cancelled; they write nothing on cancel
  if (e.type === 'SimulationReset') {
    out.push({ kind: 'signal', workflowType: 'PurchaseOrderRelease', query: "WorkflowType = 'PurchaseOrderRelease' AND ExecutionStatus = 'Running'", signal: 'cancel', payload: { reason: `simulation reset (event ${e.seq})` } });
    // pending four-eyes approvals of actions of the old world are withdrawn (ids from their request event: a uuid);
    // playbook steps (ApprovalWorkflow-<run>-<step>) and wiki proposals (ApprovalWorkflow-wiki-…) stay
    out.push({ kind: 'signal', workflowType: 'ApprovalWorkflow', query: "WorkflowType = 'ApprovalWorkflow' AND ExecutionStatus = 'Running'", signal: 'withdraw', payload: { reason: `simulation reset (event ${e.seq}): the request belongs to the replaced world` }, idPattern: '^ApprovalWorkflow-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
    return out;
  }
  const a = e.action ? actions.get(e.action) : undefined;
  if (!a || !('changes' in e.payload)) return out;
  if (a.startsWorkflow === 'PurchaseOrderRelease') {
    const po = changeOf(e, 'PurchaseOrder', e.objectId);
    if (po) {
      // v2 (D3): the ontology in force puts the due-diligence check on the release → the workflow waits for it
      const dueDiligence = (actions.get('release_purchase_order')?.preconditions ?? []).includes('due_diligence_for_high_risk_material');
      const input: PurchaseOrderReleaseInput = { poId: e.objectId, supplierId: String(po.supplier), sku: String(po.sku), qty: Number(po.qty), eta: String(po.eta), today: cfg.today, msPerSimDay: cfg.msPerSimDay, releaseAfterMs: cfg.releaseAfterMs, eventSeq: e.seq, ...(dueDiligence ? { dueDiligence, dueDiligencePollMs: cfg.dueDiligencePollMs, dueDiligenceReminderMs: cfg.dueDiligenceReminderMs } : {}) };
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
