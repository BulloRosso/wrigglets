import { condition, defineQuery, defineSignal, patched, proxyActivities, setHandler, upsertSearchAttributes, workflowInfo } from '@temporalio/workflow';
import { BSA, objectRef, type BusinessActivities } from './common.js';
import { holdable } from './hold.js';

/*
 * PurchaseOrderRelease v1 (ADR-0045), started by the dispatcher when `create_purchase_order` commits:
 *   awaiting_release (release window) → (hold?) → release (action release_purchase_order) → awaiting_delivery (timer until the ETA in
 *   simulated days) → received | late | cancelled.
 * `cancel` (signalled by cancel_purchase_order) ends it at any point. While held, nothing is released.
 * Versioning: changes that alter the command sequence use patched().
 *
 * v2 (D3, M10): when the ontology in force puts the precondition `due_diligence_for_high_risk_material` on
 * release_purchase_order, the dispatcher starts the workflow with `dueDiligence`. Before releasing, the workflow then
 * waits while the release would be refused (state awaiting_due_diligence), checks again every `dueDiligencePollMs`
 * and reminds once after `dueDiligenceReminderMs`. Workflows started before the change carry no flag and finish on v1;
 * the patch marker keeps the histories of both replayable.
 */

export interface PurchaseOrderReleaseInput {
  poId: string;
  supplierId: string;
  sku: string;
  qty: number;
  /** ETA (YYYY-MM-DD) and the simulation's current day; the delivery timer waits (eta - today) simulated days. */
  eta: string;
  today: string;
  /** Real milliseconds per simulated day (demo pace). */
  msPerSimDay: number;
  /** Release window: time for a review before the order goes to the supplier; holds placed in it stop the release. */
  releaseAfterMs: number;
  /** seq of the event that started the workflow. */
  eventSeq: number;
  /** v2: wait for a due-diligence statement before releasing (set by the dispatcher from the ontology in force). */
  dueDiligence?: boolean;
  dueDiligencePollMs?: number;
  dueDiligenceReminderMs?: number;
}

export interface PurchaseOrderReleaseResult {
  poId: string;
  outcome: 'received' | 'late' | 'cancelled' | 'release_failed';
  releasedSeq?: number;
  detail?: string;
}

export const cancelSignal = defineSignal<[{ reason?: string }]>('cancel');
export const releaseStateQuery = defineQuery<{ poId: string; state: string; releasedSeq?: number; version: 1 | 2 }>('releaseState');

const acts = proxyActivities<BusinessActivities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 10, initialInterval: '2 seconds' } });

const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export async function PurchaseOrderRelease(input: PurchaseOrderReleaseInput): Promise<PurchaseOrderReleaseResult> {
  let state = 'awaiting_release';
  let cancelled = false;
  let releasedSeq: number | undefined;
  const h = holdable(state);
  const set = (s: string) => {
    state = s;
    h.setState(s);
  };
  setHandler(cancelSignal, () => {
    cancelled = true;
  });
  const version: 1 | 2 = input.dueDiligence ? 2 : 1;
  setHandler(releaseStateQuery, () => ({ poId: input.poId, state, releasedSeq, version }));
  upsertSearchAttributes([{ key: BSA.OntologyObjects, value: [objectRef('PurchaseOrder', input.poId), objectRef('Supplier', input.supplierId), objectRef('Material', input.sku)] }]);
  set('awaiting_release');

  // release window, then nothing is released while a hold is active (or after a cancel)
  await condition(() => cancelled, input.releaseAfterMs);
  await condition(() => cancelled || !h.isHeld());
  if (cancelled) {
    set('cancelled');
    return { poId: input.poId, outcome: 'cancelled' };
  }
  if (input.dueDiligence && patched('due-diligence-gate')) {
    const since = Date.now();
    let reminded = false;
    for (;;) {
      const c = await acts.checkPreconditions({ action: 'release_purchase_order', args: { poId: input.poId } });
      if (c.ok) break;
      set('awaiting_due_diligence');
      if (!reminded && Date.now() - since >= (input.dueDiligenceReminderMs ?? 4 * 3_600_000)) {
        await acts.notify({ kind: 'due_diligence_missing', subject: `${input.poId} waits for a due-diligence statement`, body: `Purchase order ${input.poId} (${input.qty} ${input.sku} from ${input.supplierId}) is not released: ${c.reasons.join('; ')}`, ref: input.poId });
        reminded = true;
      }
      await condition(() => cancelled, input.dueDiligencePollMs ?? 60_000);
      if (cancelled) {
        set('cancelled');
        return { poId: input.poId, outcome: 'cancelled' };
      }
    }
    await condition(() => cancelled || !h.isHeld()); // a hold placed meanwhile still stops the release
    if (cancelled) {
      set('cancelled');
      return { poId: input.poId, outcome: 'cancelled' };
    }
  }
  const rel = await acts.runAction({ action: 'release_purchase_order', args: { poId: input.poId }, caller: { workflow: workflowInfo().workflowId } });
  if (!rel.ok) {
    set('release_failed');
    return { poId: input.poId, outcome: 'release_failed', detail: rel.result.slice(0, 300) };
  }
  releasedSeq = rel.seq;
  set('awaiting_delivery');

  const waitMs = Math.max(0, days(input.eta, input.today)) * input.msPerSimDay;
  await condition(() => cancelled, waitMs);
  if (cancelled) {
    set('cancelled');
    return { poId: input.poId, outcome: 'cancelled', releasedSeq };
  }
  const po = await acts.getObject({ cls: 'PurchaseOrder', id: input.poId });
  if (!po || po.status === 'cancelled') {
    set('cancelled');
    return { poId: input.poId, outcome: 'cancelled', releasedSeq };
  }
  if (po.status === 'delayed' || (typeof po.eta === 'string' && po.eta > input.eta)) {
    set('late');
    await acts.notify({ kind: 'purchase_order_late', subject: `${input.poId} is late`, body: `Purchase order ${input.poId} (${input.qty} ${input.sku} from ${input.supplierId}) was due ${input.eta}; supplier ETA is now ${String(po.eta)}.`, ref: input.poId });
    return { poId: input.poId, outcome: 'late', releasedSeq, detail: `eta ${String(po.eta)}` };
  }
  set('received');
  return { poId: input.poId, outcome: 'received', releasedSeq };
}
