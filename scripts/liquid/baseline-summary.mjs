#!/usr/bin/env node
// Summarises sofa-company scenario results into a KPI table (plan M0, task 2; used again by parity.mjs in M3).
//   node scripts/liquid/baseline-summary.mjs [--glob baseline-]   default: every <scenario>.json and baseline-<n>-<scenario>.json
// Prints a Markdown table per scenario plus min–max spread across runs.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sofa-company', 'results');
const prefix = process.argv.includes('--glob') ? process.argv[process.argv.indexOf('--glob') + 1] : undefined;
const SCENARIOS = ['supplier-beams', 'machine-failure', 'demand-spike', 'sick-leave', 'storm'];

/** One row per result file: the numbers the plan's baseline table asks for. */
export function summarise(r) {
  const k = r.kpi ?? {};
  const tasks = r.tasks ?? [];
  return {
    scenario: r.scenario,
    timedOut: !!r.timedOut,
    lateBefore: k.afterIncident?.lateOrders,
    lateAfter: k.afterMitigation?.lateOrders,
    sofasLateAfter: k.afterMitigation?.sofasLate,
    notInformedAfter: k.afterMitigation?.lateOrdersCustomerNotInformed,
    spendEur: k.afterMitigation?.costOfMeasuresEur,
    tasks: tasks.length,
    decisions: tasks.reduce((a, t) => a + (t.decisions?.length ?? 0), 0),
    writeCalls: (r.changes ?? []).length,
    guardHalts: (r.guardStops ?? []).length,
  };
}

const runs = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => (prefix ? f.startsWith(prefix) : /^(s\d-|baseline-\d+-)/.test(f)))
  .map((f) => ({ file: f, ...summarise(JSON.parse(readFileSync(path.join(dir, f), 'utf8'))) }))
  .filter((r) => SCENARIOS.includes(r.scenario));

const cols = ['file', 'lateBefore', 'lateAfter', 'sofasLateAfter', 'notInformedAfter', 'spendEur', 'tasks', 'decisions', 'writeCalls', 'guardHalts', 'timedOut'];
console.log(`| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`);
for (const s of SCENARIOS) for (const r of runs.filter((x) => x.scenario === s)) console.log(`| ${cols.map((c) => r[c] ?? '–').join(' | ')} |`);

console.log('\nSpread per scenario (min–max over runs):\n');
const num = ['lateAfter', 'sofasLateAfter', 'spendEur', 'decisions', 'writeCalls', 'guardHalts'];
console.log(`| scenario | runs | ${num.join(' | ')} |\n|---|---|${num.map(() => '---').join('|')}|`);
for (const s of SCENARIOS) {
  const rs = runs.filter((x) => x.scenario === s);
  if (!rs.length) continue;
  const span = (c) => {
    const v = rs.map((r) => r[c]).filter((x) => typeof x === 'number');
    if (!v.length) return '–';
    const lo = Math.min(...v), hi = Math.max(...v);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  };
  console.log(`| ${s} | ${rs.length} | ${num.map(span).join(' | ')} |`);
}
