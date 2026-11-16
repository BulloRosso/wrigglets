import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import { WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BSA, type ActionCaller, type BusinessActivities } from '../src/common.js';
import { approvalStateQuery, decideUpdate, type ApprovalInput } from '../src/approval.js';
import { holdSignal, holdStateQuery, releaseSignal } from '../src/hold.js';
import { cancelSignal, releaseStateQuery, type PurchaseOrderReleaseInput } from '../src/purchaseOrderRelease.js';

/*
 * Business workflows against a local Temporal dev server (like packages/workflows) with mocked activities.
 * RECORD_HISTORIES=1 stores histories for the replay test.
 */

const QUEUE = 'business-test';
let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let client: Client;
const calls: Array<{ name: string; action?: string; caller?: ActionCaller; args?: Record<string, unknown> }> = [];
let poStatus: Record<string, { status: string; eta: string }> = {};

const activities: BusinessActivities = {
  async runAction({ action, args, caller }) {
    calls.push({ name: 'runAction', action, caller, args });
    return { ok: true, result: `${action} ok`, seq: calls.length };
  },
  async getObject({ id }) {
    return poStatus[id] ?? { status: 'open', eta: '2026-10-07' };
  },
  async flushLake() {
    calls.push({ name: 'flushLake' });
    return { flushed: 3, hwm: 42 };
  },
  async notify(i) {
    calls.push({ name: `notify:${i.kind}` });
  },
};

async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: QUEUE, workflowBundle: bundle, activities });
  return worker.runUntil(fn);
}

async function record(workflowId: string) {
  if (!process.env.RECORD_HISTORIES) return;
  const history = await client.workflow.getHandle(workflowId).fetchHistory();
  const dir = fileURLToPath(new URL('./histories/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${workflowId}.json`, JSON.stringify({ workflowId, history: JSON.parse(historyToJSON(history)) }, null, 1));
}

const po = (id: string, supplierId: string, over: Partial<PurchaseOrderReleaseInput> = {}): PurchaseOrderReleaseInput => ({ poId: id, supplierId, sku: 'BEAM-PINE-80', qty: 2000, eta: '2026-10-07', today: '2026-10-05', msPerSimDay: 200, releaseAfterMs: 0, eventSeq: 1, ...over });

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal({ server: { searchAttributes: Object.values(BSA) } });
  client = env.client;
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../dist/index.js', import.meta.url)), logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } as never });
});
afterAll(async () => env?.teardown());
beforeEach(() => {
  calls.length = 0;
  poStatus = {};
});

describe('PurchaseOrderRelease', () => {
  it('releases through the action, waits for the ETA and reports received; tags its ontology objects', async () => {
    const id = 'po-release-happy';
    const out = await withWorker(async () => {
      const h = await client.workflow.start('PurchaseOrderRelease', { taskQueue: QUEUE, workflowId: id, args: [po('PO-4430', 'S-BALTIC')] });
      return h.result();
    });
    expect(out).toEqual({ poId: 'PO-4430', outcome: 'received', releasedSeq: 1 });
    expect(calls.filter((c) => c.name === 'runAction')).toEqual([{ name: 'runAction', action: 'release_purchase_order', args: { poId: 'PO-4430' }, caller: { workflow: id } }]);
    const desc = await client.workflow.getHandle(id).describe();
    expect(desc.typedSearchAttributes.get(BSA.OntologyObjects)).toEqual(['PurchaseOrder:PO-4430', 'Supplier:S-BALTIC', 'Material:BEAM-PINE-80']);
    expect(desc.typedSearchAttributes.get(BSA.BusinessState)).toBe('received');
    await record(id);
  });

  it('reports late when the supplier moved the ETA', async () => {
    poStatus['PO-4431'] = { status: 'delayed', eta: '2026-11-30' };
    const out = await withWorker(async () => (await client.workflow.start('PurchaseOrderRelease', { taskQueue: QUEUE, workflowId: 'po-release-late', args: [po('PO-4431', 'S-NORDHOLZ')] })).result());
    expect(out).toMatchObject({ outcome: 'late', detail: 'eta 2026-11-30' });
    expect(calls.map((c) => c.name)).toContain('notify:purchase_order_late');
  });

  it('cancel ends it without a release', async () => {
    const out = await withWorker(async () => {
      const h = await client.workflow.start('PurchaseOrderRelease', { taskQueue: QUEUE, workflowId: 'po-release-cancel', args: [po('PO-4432', 'S-BALTIC', { releaseAfterMs: 60_000 })] });
      await h.signal(cancelSignal, { reason: 'replaced' });
      return h.result();
    });
    expect(out).toEqual({ poId: 'PO-4432', outcome: 'cancelled' });
    expect(calls.filter((c) => c.name === 'runAction')).toEqual([]);
  });

  it('holding all workflows of a supplier (visibility query) pauses exactly those; release resumes; survives a worker restart', async () => {
    const ids = { a: 'po-hold-nordholz-1', b: 'po-hold-nordholz-2', c: 'po-hold-baltic-1' };
    // phase 1: start in the release window, hold by OntologyObjects, let the window pass
    await withWorker(async () => {
      await client.workflow.start('PurchaseOrderRelease', { taskQueue: QUEUE, workflowId: ids.a, args: [po('PO-5001', 'S-NORDHOLZ', { releaseAfterMs: 2500 })] });
      await client.workflow.start('PurchaseOrderRelease', { taskQueue: QUEUE, workflowId: ids.b, args: [po('PO-5002', 'S-NORDHOLZ', { releaseAfterMs: 2500 })] });
      await client.workflow.start('PurchaseOrderRelease', { taskQueue: QUEUE, workflowId: ids.c, args: [po('PO-5003', 'S-BALTIC', { releaseAfterMs: 2500 })] });
      const query = "OntologyObjects = 'Supplier:S-NORDHOLZ' AND ExecutionStatus = 'Running'";
      let matched: string[] = [];
      for (let i = 0; i < 40 && matched.length < 2; i++) {
        matched = [];
        for await (const w of client.workflow.list({ query })) matched.push(w.workflowId);
        if (matched.length < 2) await sleep(250);
      }
      expect(matched.sort()).toEqual([ids.a, ids.b].sort());
      for (const id of matched) await client.workflow.getHandle(id).signal(holdSignal, { reason: 'supplier under review', ref: 'playbook-run-1' });
      await sleep(4000);
      const held = await client.workflow.getHandle(ids.a).query(holdStateQuery);
      expect(held).toMatchObject({ held: true, state: 'awaiting_release', holds: [{ ref: 'playbook-run-1', reason: 'supplier under review' }] });
    });
    expect(calls.filter((c) => c.name === 'runAction').map((c) => c.args!.poId)).toEqual(['PO-5003']);
    // phase 2: a NEW worker (restart) — release, both continue; nothing was lost
    const results = await withWorker(async () => {
      for (const id of [ids.a, ids.b]) await client.workflow.getHandle(id).signal(releaseSignal, { ref: 'playbook-run-1' });
      return Promise.all([ids.a, ids.b, ids.c].map((id) => client.workflow.getHandle(id).result()));
    });
    expect(results.map((r) => r.outcome)).toEqual(['received', 'received', 'received']);
    expect(calls.filter((c) => c.name === 'runAction').map((c) => c.args!.poId).sort()).toEqual(['PO-5001', 'PO-5002', 'PO-5003']);
    await record(ids.a);
  }, 60_000);

  it('a second hold with another ref keeps it held after the first is released', async () => {
    const id = 'po-hold-two-refs';
    await withWorker(async () => {
      const h = await client.workflow.start('PurchaseOrderRelease', { taskQueue: QUEUE, workflowId: id, args: [po('PO-5010', 'S-COMO', { releaseAfterMs: 500 })] });
      await h.signal(holdSignal, { reason: 'a', ref: 'r1' });
      await h.signal(holdSignal, { reason: 'b', ref: 'r2' });
      await h.signal(releaseSignal, { ref: 'r1' });
      await sleep(1500);
      expect((await h.query(releaseStateQuery)).state).toBe('awaiting_release');
      expect((await h.query(holdStateQuery)).holds.map((x) => x.ref)).toEqual(['r2']);
      await h.signal(releaseSignal, { ref: 'r2' });
      await h.result();
    });
    expect(calls.filter((c) => c.name === 'runAction')).toHaveLength(1);
  });
});

const approvalInput = (over: Partial<ApprovalInput> = {}): ApprovalInput => ({
  requestSeq: 77,
  action: 'create_purchase_order',
  args: { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 },
  caller: { agent: 'sofa-lara', user: 'stefan@x' },
  target: 'PurchaseOrder',
  reason: 'require_four_eyes',
  objects: ['Supplier:S-BALTIC'],
  reminderMs: 60_000,
  expireMs: 120_000,
  ...over,
});

describe('ApprovalWorkflow', () => {
  it('approve runs the action with approvedBy; the requester cannot approve', async () => {
    const id = 'approval-77';
    const out = await withWorker(async () => {
      const h = await client.workflow.start('ApprovalWorkflow', { taskQueue: QUEUE, workflowId: id, args: [approvalInput()] });
      await expect(h.executeUpdate(decideUpdate, { args: [{ decision: 'approve', by: 'stefan@x' }] })).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
      expect((await h.query(approvalStateQuery)).state).toBe('pending');
      const s = await h.executeUpdate(decideUpdate, { args: [{ decision: 'approve', by: 'ben@x', comment: 'ok' }] });
      expect(s.decision).toEqual({ decision: 'approve', by: 'ben@x', comment: 'ok' });
      return h.result();
    });
    expect(out.state).toBe('executed');
    expect(calls.filter((c) => c.name === 'runAction')).toEqual([{ name: 'runAction', action: 'create_purchase_order', args: { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 2000 }, caller: { agent: 'sofa-lara', user: 'stefan@x', approvedBy: 'ben@x', workflow: id } }]);
    await record(id);
  });

  it('reject runs nothing; a second decision is refused', async () => {
    const out = await withWorker(async () => {
      const h = await client.workflow.start('ApprovalWorkflow', { taskQueue: QUEUE, workflowId: 'approval-78', args: [approvalInput({ requestSeq: 78 })] });
      await h.executeUpdate(decideUpdate, { args: [{ decision: 'reject', by: 'ben@x' }] });
      const out = await h.result();
      // decided and completed: a second decision is refused (update failed or workflow already closed)
      await expect(h.executeUpdate(decideUpdate, { args: [{ decision: 'approve', by: 'paula@x' }] })).rejects.toThrow();
      return out;
    });
    expect(out.state).toBe('rejected');
    expect(calls.filter((c) => c.name === 'runAction')).toEqual([]);
  });

  it('reminds once, then expires without running anything', async () => {
    const out = await withWorker(async () => (await client.workflow.start('ApprovalWorkflow', { taskQueue: QUEUE, workflowId: 'approval-79', args: [approvalInput({ requestSeq: 79, reminderMs: 500, expireMs: 1200 })] })).result());
    expect(out.state).toBe('expired');
    expect(calls.map((c) => c.name)).toEqual(['notify:approval_reminder']);
  });
});

describe('lakeFlush', () => {
  it('runs the flush activity', async () => {
    const out = await withWorker(async () => (await client.workflow.start('lakeFlush', { taskQueue: QUEUE, workflowId: 'lake-flush-test' })).result());
    expect(out).toEqual({ flushed: 3, hwm: 42 });
  });
});
