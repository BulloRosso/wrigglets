import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { blastRadius, checkStep, matching, render, safetyDecision, safetyRuleToPlaybook, triggers, validatePlaybook, type SafetyRuleLike } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const example = YAML.parse(readFileSync(path.join(root, 'playbooks/third-party-upstream-vulnerability.yaml'), 'utf8'));
const ir = JSON.parse(readFileSync(path.join(root, 'packages/ontology-sofa/ir/ontology.ir.json'), 'utf8'));

describe('validator', () => {
  it('accepts the example playbook', () => {
    const r = validatePlaybook(example);
    expect(r.issues).toEqual([]);
    expect(r.playbook!.steps.map((s) => s.id)).toEqual(['disable-upstream', 'tighten-policy', 'hold-workflows', 'notify-owners', 'propose-fix', 'replay', 'restore']);
  });
  it('rejects auto-loosening (tighten-only rule), unknown steps and duplicate ids', () => {
    const bad = structuredClone(example);
    bad.steps.find((s: { id: string }) => s.id === 'restore').autonomy = 'auto';
    bad.steps.push({ id: 'reopen', type: 'gateway.upstream.enable', autonomy: 'propose', with: { upstream: 'erp' } });
    bad.steps.push({ id: 'magic', type: 'shell.exec', autonomy: 'auto' });
    bad.steps.push({ id: 'replay', type: 'notify', autonomy: 'auto', with: { subject: 'x' } });
    const msgs = validatePlaybook(bad).issues.map((i) => i.message);
    expect(msgs.filter((m) => /must have autonomy "human"/.test(m))).toHaveLength(2);
    expect(msgs.some((m) => /unknown step type shell.exec/.test(m))).toBe(true);
    expect(msgs.some((m) => /duplicate step id replay/.test(m))).toBe(true);
  });
  it('checks literal step inputs before rendering', () => {
    const bad = structuredClone(example);
    bad.steps[0].with = { upstream: 'erp', port: 1 };
    expect(validatePlaybook(bad).issues[0]!.message).toMatch(/Unrecognized key/);
  });
  it('run time: a loosening step without a person is refused even if the file was valid', () => {
    expect(checkStep({ type: 'restore', autonomy: 'human' }, {})).toMatchObject({ ok: false });
    expect(checkStep({ type: 'restore', autonomy: 'human' }, {}, 'ada@x')).toMatchObject({ ok: true });
    expect(checkStep({ type: 'temporal.release', autonomy: 'auto' }, { ref: 'r' }, 'ada@x')).toMatchObject({ ok: false });
    expect(checkStep({ type: 'gateway.upstream.disable', autonomy: 'auto' }, {})).toMatchObject({ ok: false });
  });
});

describe('templates and triggers', () => {
  const ctx = { trigger: { upstream: 'erp', summary: 'CVE-1' }, blast: { writeActions: ['a', 'b'], tools: ['x', 'y'] }, run: { id: 'r-1' } };
  it('renders whole values as values and inline values as text', () => {
    expect(render({ actions: '{{ blast.writeActions }}', reason: 'upstream {{ trigger.upstream }}: {{ blast.writeActions }} ({{ blast.tools.length }})' }, ctx)).toEqual({ actions: ['a', 'b'], reason: 'upstream erp: a, b (2)' });
    expect(() => render('{{ blast.nope }}', ctx)).toThrow(/unknown template value/);
  });
  it('matches alerts by fields (arrays = any of)', () => {
    const t = validatePlaybook(example).playbook!.trigger;
    expect(triggers(t, { kind: 'alert', data: { source: 'vuln-feed', severity: 'critical', upstream: 'erp' } })).toBe(true);
    expect(triggers(t, { kind: 'alert', data: { source: 'vuln-feed', severity: 'low' } })).toBe(false);
    expect(triggers(t, { kind: 'safety_metric', data: { source: 'vuln-feed', severity: 'high' } })).toBe(false);
    expect(matching([validatePlaybook(example).playbook!], { kind: 'alert', data: { source: 'vuln-feed', severity: 'high' } })).toHaveLength(1);
  });
});

describe('blast radius on the sofa ontology', () => {
  it('erp upstream → its tools → actions → classes → running workflows', () => {
    const tools = ['erp__create_purchase_order', 'erp__list_suppliers', 'erp__release_stock', 'crm__list_customers', 'wiki__search'];
    const b = blastRadius({ upstream: 'erp', tools, actions: ir.actions, workflows: [{ workflowId: 'PurchaseOrderRelease-1', objects: ['PurchaseOrder:PO-1', 'Supplier:S-NORDHOLZ', 'Material:BEAM-PINE-80'] }, { workflowId: 'Other-1', objects: ['Customer:C-01'] }] });
    expect(b.tools).toEqual(['erp__create_purchase_order', 'erp__list_suppliers', 'erp__release_stock']);
    expect(b.writeActions).toEqual(['create_purchase_order', 'release_stock']);
    expect(b.classes).toEqual(expect.arrayContaining(['PurchaseOrder', 'Supplier', 'Material']));
    expect(b.classes).not.toContain('Customer');
    expect(b.workflows).toEqual(['PurchaseOrderRelease-1']);
    expect(b.objects).toEqual(['Material:BEAM-PINE-80', 'PurchaseOrder:PO-1', 'Supplier:S-NORDHOLZ']);
  });
});

describe('safety rules as playbooks', () => {
  const rules: SafetyRuleLike[] = [
    { id: 'permission-violation', kind: 'permission_violation', enabled: true, threshold: 1, windowMinutes: 60, level: 'paused' },
    { id: 'tool-denials', kind: 'tool_denials', enabled: true, threshold: 20, windowMinutes: 10, level: 'tools_off' },
    { id: 'off', kind: 'tool_rate', enabled: false, threshold: 5, windowMinutes: 1, level: 'stopped' },
  ];
  it('the same inputs trip the same levels', () => {
    for (const r of rules) {
      const p = safetyRuleToPlaybook(r);
      expect(validatePlaybook(p).issues).toEqual([]);
      for (const value of [0, r.threshold - 1, r.threshold, r.threshold * 3]) {
        const engine = safetyDecision(r, value);
        // the engine emits a safety_metric event when it trips; the playbook reacts to exactly that event
        const fired = engine.tripped && triggers(p.trigger, { kind: 'safety_metric', data: { rule: r.id, agent: 'sofa-max', level: engine.level } }, p.id);
        const level = fired ? (render(p.steps[0]!.with, { trigger: { agent: 'sofa-max' } }) as { level: string }).level : undefined;
        expect({ rule: r.id, value, level }).toEqual({ rule: r.id, value, level: engine.level });
      }
    }
  });
});
