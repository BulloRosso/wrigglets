import { describe, expect, it } from 'vitest';
import { PARITY_CALLS } from './calls.js';
import { SCENARIO_IDS, SofaCompany } from './company.js';
import { applyChanges, diffObjects, metaOf, objectsToWorld, worldToObjects, type Objects } from './objects.js';

const play = (scenario: string) => {
  const d = new SofaCompany();
  if (scenario !== 'baseline') d.scenario(scenario as (typeof SCENARIO_IDS)[number]);
  for (const [name, args] of PARITY_CALLS) d.call(name, structuredClone(args));
  return d;
};
const sorted = (o: Objects) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort((a, b) => a.ord - b.ord)])));

describe.each(['baseline', ...SCENARIO_IDS])('world <-> objects: %s', (scenario) => {
  it('round trip gives the identical world (values, key order, list order)', () => {
    const d = play(scenario);
    const back = objectsToWorld(worldToObjects(d.W), metaOf(d.W, d.seq, d.writes));
    expect(JSON.stringify(back.world)).toBe(JSON.stringify(d.W));
    expect(back.seq).toEqual(d.seq);
    expect(back.writes).toBe(d.writes);
    // a reloaded company answers exactly like the original
    const r = new SofaCompany(back);
    for (const name of ['get_overview', 'list_orders', 'get_inventory', 'list_workers', 'get_kpi']) expect(r.call(name, {}).text).toBe(d.call(name, {}).text);
  });

  it('diff + apply reproduces the new state from the old one', () => {
    const fresh = worldToObjects(new SofaCompany().W);
    const after = worldToObjects(play(scenario).W);
    const changes = diffObjects(fresh, after);
    expect(changes.length).toBeGreaterThan(0);
    expect(sorted(applyChanges(fresh, changes))).toBe(sorted(after));
    expect(diffObjects(after, after)).toEqual([]);
  });
});

describe('objects', () => {
  it('cover every class of the ontology with the T0 counts of the extract', () => {
    const o = worldToObjects(new SofaCompany().W);
    expect(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.length]))).toEqual({
      Factory: 2, Machine: 6, Worker: 4, Absence: 0, OvertimeShift: 0, TempWorkerAssignment: 0, Material: 5, Bom: 3, Supplier: 7, InventoryItem: 5,
      PurchaseOrder: 4, ProductionOrder: 18, MaintenanceTicket: 0, Incident: 0, Customer: 6, SalesOrder: 18, CustomerNotice: 0, Campaign: 1, DemandSignal: 18,
    });
  });
  it('a removed object becomes a change with after = null', () => {
    const a = worldToObjects(new SofaCompany().W);
    const b = structuredClone(a);
    b.PurchaseOrder = b.PurchaseOrder!.slice(1);
    expect(diffObjects(a, b)).toEqual([{ class: 'PurchaseOrder', id: 'PO-4411', after: null }]);
  });
});
