import { describe, expect, it } from 'vitest';
import { evaluateChecks, replayPrecondition, type ObjectsView } from './checks.js';

const world = (over: Partial<ObjectsView> = {}): ObjectsView => ({
  PurchaseOrder: [
    { id: 'PO-1', supplier: 'S-NORDHOLZ', sku: 'BEAM-PINE-80' },
    { id: 'PO-2', supplier: 'S-BALTIC', sku: 'BEAM-PINE-80' },
    { id: 'PO-3', supplier: 'S-NORDHOLZ', sku: 'FOAM-HR40' },
  ],
  Material: [{ sku: 'BEAM-PINE-80', commodity_risk: 'high' }, { sku: 'FOAM-HR40', commodity_risk: 'low' }],
  DueDiligenceStatement: [{ id: 'DDS-001', supplier: 'S-BALTIC', sanctions_checked: true }],
  ...over,
});
const check = (poId: string, o = world()) => evaluateChecks(['purchase_order_open_not_released', 'due_diligence_for_high_risk_material'], { args: { poId }, objects: o });

describe('core check due_diligence_for_high_risk_material (D3)', () => {
  it('refuses the release of a high-risk material without a valid statement of the supplier', () => {
    expect(check('PO-1')).toEqual(['PO-1 needs a valid due-diligence statement of supplier S-NORDHOLZ before release: BEAM-PINE-80 is a high-risk commodity']);
  });
  it('allows it with a valid statement, for low-risk materials, and leaves domain preconditions to the domain', () => {
    expect(check('PO-2')).toEqual([]);
    expect(check('PO-3')).toEqual([]);
  });
  it('a statement without sanctions screening is not valid', () => {
    expect(check('PO-2', world({ DueDiligenceStatement: [{ id: 'DDS-001', supplier: 'S-BALTIC', sanctions_checked: false }] }))).toHaveLength(1);
  });
  it('materials without a risk class (before the change) are not affected', () => {
    expect(check('PO-1', world({ Material: [{ sku: 'BEAM-PINE-80' }] }))).toEqual([]);
  });
});

describe('shadow replay of the precondition', () => {
  it('counts the releases that would have been blocked, with assumed risk classes', () => {
    const events = [
      { seq: 10, objectId: 'PO-1', order: { id: 'PO-1', supplier: 'S-NORDHOLZ', sku: 'BEAM-PINE-80' } },
      { seq: 11, objectId: 'PO-2', order: { id: 'PO-2', supplier: 'S-BALTIC', sku: 'BEAM-PINE-80' } },
      { seq: 12, objectId: 'PO-3', order: { id: 'PO-3', supplier: 'S-NORDHOLZ', sku: 'FOAM-HR40' } },
      { seq: 13, objectId: 'PO-9', order: null },
    ];
    const r = replayPrecondition({ precondition: 'due_diligence_for_high_risk_material', events, objects: world({ Material: [{ sku: 'BEAM-PINE-80' }, { sku: 'FOAM-HR40' }] }), assume: { Material: { 'BEAM-PINE-80': { commodity_risk: 'high' } } } });
    expect(r).toMatchObject({ total: 3, blocked: 1, share: 33.3 });
    expect(r.examples[0]).toMatchObject({ seq: 10, poId: 'PO-1' });
  });
});
