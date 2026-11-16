import { describe, expect, it } from 'vitest';
import { SCENARIO_IDS, SofaCompany, type Args } from './company.js';

/*
 * Deterministic parity with the reference implementation (plan M3 exit criterion): the same calls against the mock and
 * the domain package give the same answers, byte for byte (timestamps of customer notices normalised), and the same
 * state and KPI afterwards.
 */

type MockTool = { name: string; run: (a: Args) => { content: Array<{ text: string }>; isError?: boolean } };
// @ts-expect-error plain .mjs without types; importing does not start the mock server
const mock = (await import('../../../scripts/sofa-company/mock-mcp.mjs')) as {
  SERVERS: Record<string, { tools: MockTool[] }>;
  mockControl: { reset(): void; scenario(id: string): void; kpi(): Record<string, unknown>; world(): Record<string, unknown> & { log: unknown[] }; seq(): Record<string, number> };
};

const mockTools = new Map(Object.values(mock.SERVERS).flatMap((s) => s.tools.map((t) => [t.name, t] as const)));
const callMock = (name: string, a: Args) => {
  const t = mockTools.get(name)!;
  try {
    const out = t.run(a);
    return { text: out.content[0]!.text, isError: !!out.isError };
  } catch (e) {
    return { text: `Tool failed: ${(e as Error).message}`, isError: true };
  }
};
const norm = (s: string) => s.replace(/"at": "[^"]+"/g, '"at": "<t>"');

import { PARITY_CALLS as COMMON } from './calls.js';

describe.each(['baseline', ...SCENARIO_IDS])('parity with the mock: %s', (scenario) => {
  it('every answer, the final state and the KPI are identical', () => {
    mock.mockControl.reset();
    const d = new SofaCompany();
    if (scenario !== 'baseline') {
      mock.mockControl.scenario(scenario);
      d.scenario(scenario as (typeof SCENARIO_IDS)[number]);
    }
    for (const [name, args] of COMMON) {
      const m = mockTools.has(name) ? callMock(name, structuredClone(args)) : { text: `Unknown tool ${name}`, isError: true };
      const o = d.call(name, structuredClone(args));
      expect(norm(o.text), `${scenario} ${name} ${JSON.stringify(args)}`).toBe(norm(m.text));
      expect(o.isError, `${scenario} ${name} isError`).toBe(m.isError);
    }
    const mw = structuredClone(mock.mockControl.world());
    const { log, ...mrest } = mw;
    const { log: _dlog, ...dw } = structuredClone(d.W) as unknown as Record<string, unknown>;
    expect(norm(JSON.stringify(dw)), 'world').toBe(norm(JSON.stringify(mrest)));
    expect(d.seq).toEqual(mock.mockControl.seq());
    expect(d.writes).toBe((log as unknown[]).length);
    expect(d.kpi()).toEqual(mock.mockControl.kpi());
  });
});

describe('domain instance', () => {
  it('clone is independent (what-if never changes the original)', () => {
    const d = new SofaCompany();
    const before = JSON.stringify(d.W);
    d.call('simulate_change', { tool: 'create_purchase_order', arguments: { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 } });
    expect(JSON.stringify(d.W)).toBe(before);
    expect(d.writes).toBe(0);
  });
  it('records the last write like the mock log', () => {
    const d = new SofaCompany();
    d.call('request_overtime', { factory: 'F-NORTH', from: '2026-10-06', to: '2026-10-09' });
    expect(d.lastWrite).toEqual({ tool: 'erp.request_overtime', args: { factory: 'F-NORTH', from: '2026-10-06', to: '2026-10-09' }, result: '4 days' });
  });
});
