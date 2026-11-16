import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import type { Client } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validatePlaybook, type Playbook } from '@cw/playbooks';
import { BSA } from '../src/common.js';
import { cancelRunSignal, decideStepUpdate, playbookRunQuery, type PlaybookActivities, type PlaybookRunState } from '../src/playbookRun.js';

const QUEUE = 'playbook-test';
const example = validatePlaybook(YAML.parse(readFileSync(fileURLToPath(new URL('../../../playbooks/third-party-upstream-vulnerability.yaml', import.meta.url)), 'utf8'))).playbook as Playbook;
let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let client: Client;
const executed: Array<{ id: string; type: string; with: Record<string, unknown>; approvedBy?: string; prior: Array<{ id: string; undo?: unknown }> }> = [];
const recorded: string[] = [];

const activities: PlaybookActivities = {
  async assessBlast() {
    return { upstream: 'erp', tools: ['erp__create_purchase_order'], actions: ['create_purchase_order'], writeActions: ['create_purchase_order'], classes: ['PurchaseOrder', 'Supplier'], objects: ['Supplier:S-NORDHOLZ'], workflows: ['PurchaseOrderRelease-1'] };
  },
  async executeStep({ step, with: w, approvedBy, prior }) {
    executed.push({ id: step.id, type: step.type, with: w, approvedBy, prior: prior.map((p) => ({ id: p.id, undo: p.undo })) });
    if (step.type === 'agent.task') return { ok: true, summary: 'task request created', proposed: true };
    return { ok: true, summary: `${step.type} done`, undo: step.type === 'gateway.upstream.disable' ? { upstream: 'erp', wasEnabled: true } : undefined };
  },
  async recordRun({ type }) {
    recorded.push(type);
  },
};
const withWorker = async <T>(fn: () => Promise<T>) => (await Worker.create({ connection: env.nativeConnection, taskQueue: QUEUE, workflowBundle: bundle, activities })).runUntil(fn);
const start = (id: string) => client.workflow.start('PlaybookRun', { taskQueue: QUEUE, workflowId: id, args: [{ runId: id, playbook: example, trigger: { kind: 'alert', data: { source: 'vuln-feed', severity: 'critical', upstream: 'erp', summary: 'CVE-2026-1' } }, startedBy: 'alert' }] });
const until = async (id: string, pred: (s: PlaybookRunState) => boolean) => {
  for (let i = 0; i < 200; i++) {
    const s = await client.workflow.getHandle(id).query(playbookRunQuery);
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
};

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal({ server: { searchAttributes: Object.values(BSA) } });
  client = env.client;
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../dist/index.js', import.meta.url)), logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } as never });
});
afterAll(async () => env?.teardown());
beforeEach(() => {
  executed.length = 0;
  recorded.length = 0;
});

describe('PlaybookRun', () => {
  it('tightening steps run automatically, propose does not block, restore waits for a person and gets the undo data', async () => {
    await withWorker(async () => {
      const h = await start('run-1');
      const waiting = await until('run-1', (s) => s.state === 'awaiting_approval');
      expect(waiting.steps.map((s) => `${s.id}:${s.state}`)).toEqual(['disable-upstream:done', 'tighten-policy:done', 'hold-workflows:done', 'notify-owners:done', 'propose-fix:proposed', 'replay:done', 'restore:awaiting_approval']);
      expect(executed.find((e) => e.id === 'tighten-policy')!.with).toMatchObject({ actions: ['create_purchase_order'], obligation: 'require_four_eyes', reason: 'Vulnerability in upstream erp: CVE-2026-1' });
      expect(executed.find((e) => e.id === 'hold-workflows')!.with).toMatchObject({ objects: ['Supplier:S-NORDHOLZ'], ref: 'run-1' });
      expect(executed.some((e) => e.type === 'restore')).toBe(false);
      await h.executeUpdate(decideStepUpdate, { args: [{ stepId: 'restore', decision: 'approve', by: 'ada@x', comment: 'patched' }] });
      const done = await h.result();
      expect(done.state).toBe('completed');
      const restore = executed.find((e) => e.type === 'restore')!;
      expect(restore.approvedBy).toBe('ada@x');
      expect(restore.prior.find((p) => p.id === 'disable-upstream')!.undo).toEqual({ upstream: 'erp', wasEnabled: true });
      expect(recorded).toEqual(['PlaybookStepAwaitingApproval', 'PlaybookStepDecided', 'PlaybookRunFinished']);
    });
  });

  it('cancel never loosens: a cancelled run does not restore', async () => {
    await withWorker(async () => {
      const h = await start('run-2');
      await until('run-2', (s) => s.state === 'awaiting_approval');
      await h.signal(cancelRunSignal, { by: 'ada@x', reason: 'handled manually' });
      const s = await h.result();
      expect(s.state).toBe('cancelled');
      expect(s.steps.find((x) => x.id === 'restore')!.state).toBe('cancelled');
      expect(executed.some((e) => e.type === 'restore')).toBe(false);
    });
  });

  it('a rejected human step is skipped; deciding twice or a non-waiting step is refused', async () => {
    await withWorker(async () => {
      const h = await start('run-3');
      await until('run-3', (s) => s.state === 'awaiting_approval');
      await expect(h.executeUpdate(decideStepUpdate, { args: [{ stepId: 'replay', decision: 'approve', by: 'ada@x' }] })).rejects.toThrow();
      await h.executeUpdate(decideStepUpdate, { args: [{ stepId: 'restore', decision: 'reject', by: 'ada@x' }] });
      const s = await h.result();
      expect(s.steps.find((x) => x.id === 'restore')!.state).toBe('skipped');
      expect(executed.some((e) => e.type === 'restore')).toBe(false);
    });
  });

  it('survives a worker restart while waiting for the person', async () => {
    const h = await withWorker(async () => {
      const handle = await start('run-4');
      await until('run-4', (s) => s.state === 'awaiting_approval');
      return handle;
    });
    // worker gone; a new one picks the run up where it was
    const n = executed.length;
    await withWorker(async () => {
      await h.executeUpdate(decideStepUpdate, { args: [{ stepId: 'restore', decision: 'approve', by: 'ben@x' }] });
      expect((await h.result()).state).toBe('completed');
    });
    expect(executed.slice(n).map((e) => e.type)).toEqual(['restore']);
  });
});
