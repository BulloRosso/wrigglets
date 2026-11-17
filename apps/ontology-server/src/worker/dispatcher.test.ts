import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandsFor, objectsOf, type DispatchEvent, type IrActionLite } from './dispatcher.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ir = JSON.parse(readFileSync(path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json'), 'utf8')) as { actions: IrActionLite[] };
const actions = new Map(ir.actions.map((a) => [a.name, a]));
const cfg = { today: '2026-10-05', msPerSimDay: 1000, releaseAfterMs: 5000, approvalReminderMs: 60_000, approvalExpireMs: 120_000 };
const ev = (over: Partial<DispatchEvent>): DispatchEvent => ({ seq: 10, eventId: 'e-1', type: 'X', objectType: 'PurchaseOrder', objectId: 'PO-4430', action: null, actorAgent: 'sofa-lara', actorUser: 'stefan@x', taskId: 't-1', workflowId: null, payload: {}, ...over });

describe('dispatcher', () => {
  it('create_purchase_order (starts_workflow in the ontology) starts PurchaseOrderRelease with an id from the event', () => {
    const e = ev({ type: 'PurchaseOrderCreated', action: 'create_purchase_order', payload: { changes: [{ class: 'PurchaseOrder', id: 'PO-4430', after: { id: 'PO-4430', supplier: 'S-BALTIC', sku: 'BEAM-PINE-80', qty: 6000, eta: '2026-10-09' } }] } });
    expect(commandsFor(e, actions, cfg)).toEqual([
      {
        kind: 'start',
        workflowType: 'PurchaseOrderRelease',
        workflowId: 'PurchaseOrderRelease-e-1',
        args: [{ poId: 'PO-4430', supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', qty: 6000, eta: '2026-10-09', today: '2026-10-05', msPerSimDay: 1000, releaseAfterMs: 5000, eventSeq: 10 }],
        objects: ['PurchaseOrder:PO-4430', 'Supplier:S-BALTIC', 'Material:BEAM-PINE-80'],
      },
    ]);
  });

  it('cancel_purchase_order (signals_workflow) signals the running workflows of that purchase order', () => {
    const e = ev({ type: 'PurchaseOrderCancelled', action: 'cancel_purchase_order', payload: { changes: [] } });
    expect(commandsFor(e, actions, cfg)).toEqual([{ kind: 'signal', workflowType: 'PurchaseOrderRelease', query: "WorkflowType = 'PurchaseOrderRelease' AND OntologyObjects = 'PurchaseOrder:PO-4430' AND ExecutionStatus = 'Running'", signal: 'cancel', payload: { reason: 'cancel_purchase_order (event 10)' } }]);
  });

  it('an approval request starts an ApprovalWorkflow with the touched objects', () => {
    const e = ev({ type: 'ActionApprovalRequested', action: 'create_purchase_order', payload: { input: { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 }, reason: 'allowed' } });
    const [c] = commandsFor(e, actions, cfg);
    expect(c).toMatchObject({ kind: 'start', workflowType: 'ApprovalWorkflow', workflowId: 'ApprovalWorkflow-e-1', objects: ['Supplier:S-BALTIC', 'Material:BEAM-PINE-80'] });
    expect((c as { args: Array<Record<string, unknown>> }).args[0]).toMatchObject({ requestSeq: 10, action: 'create_purchase_order', caller: { agent: 'sofa-lara', user: 'stefan@x', task: 't-1' }, target: 'PurchaseOrder', reminderMs: 60_000, expireMs: 120_000 });
  });

  it('other events start nothing; events without changes (tests, notifications) are ignored', () => {
    expect(commandsFor(ev({ type: 'OvertimeBooked', action: 'request_overtime', payload: { changes: [] } }), actions, cfg)).toEqual([]);
    expect(commandsFor(ev({ type: 'PurchaseOrderCreated', action: 'create_purchase_order', payload: {} }), actions, cfg)).toEqual([]);
    expect(commandsFor(ev({ type: 'BusinessNotification', payload: {} }), actions, cfg)).toEqual([]);
  });

  it('v2 (D3): with the due-diligence check on the release in the ontology, new release workflows wait for it', () => {
    const e = ev({ type: 'PurchaseOrderCreated', action: 'create_purchase_order', payload: { changes: [{ class: 'PurchaseOrder', id: 'PO-4430', after: { supplier: 'S-BALTIC', sku: 'BEAM-PINE-80', qty: 1500, eta: '2026-10-09' } }] } });
    const v1 = commandsFor(e, actions, cfg)[0] as { args: Array<Record<string, unknown>> };
    expect(v1.args[0]!.dueDiligence).toBeUndefined();
    const withCheck = new Map(actions);
    withCheck.set('release_purchase_order', { name: 'release_purchase_order', target: 'PurchaseOrder', input: [], preconditions: ['purchase_order_open_not_released', 'due_diligence_for_high_risk_material'] });
    const v2 = commandsFor(e, withCheck, { ...cfg, dueDiligencePollMs: 5000, dueDiligenceReminderMs: 20_000 })[0] as { args: Array<Record<string, unknown>> };
    expect(v2.args[0]).toMatchObject({ dueDiligence: true, dueDiligencePollMs: 5000, dueDiligenceReminderMs: 20_000 });
  });

  it('a simulation reset cancels the running release workflows of the old world', () => {
    const c = commandsFor(ev({ type: 'SimulationReset', objectType: 'Company', objectId: 'sofa', payload: { changes: [] } }), actions, cfg);
    expect(c[0]).toEqual({ kind: 'signal', workflowType: 'PurchaseOrderRelease', query: "WorkflowType = 'PurchaseOrderRelease' AND ExecutionStatus = 'Running'", signal: 'cancel', payload: { reason: 'simulation reset (event 10)' } });
    expect(c[1]).toMatchObject({ workflowType: 'ApprovalWorkflow', signal: 'withdraw' });
    const only = new RegExp(c[1]!.kind === 'signal' ? c[1]!.idPattern! : '');
    expect(only.test('ApprovalWorkflow-3f2b1c4d-1111-4222-8333-944455556666')).toBe(true); // four-eyes request
    expect(only.test('ApprovalWorkflow-pr-mwjyq86r-42de-restore')).toBe(false); // playbook step
    expect(only.test('ApprovalWorkflow-wiki-abc')).toBe(false);
  });

  it('objectsOf resolves class-typed and multi-valued inputs', () => {
    expect(objectsOf(actions.get('send_customer_notice'), { customerId: 'C-01', orderIds: ['SO-1', 'SO-2'] })).toEqual(['Customer:C-01', 'SalesOrder:SO-1', 'SalesOrder:SO-2']);
  });
});
