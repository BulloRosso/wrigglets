import type { Client } from '@temporalio/client';
import { approvalStateQuery, BSA, decideUpdate, holdSignal, holdStateQuery, releaseSignal, type ApprovalState, type HoldState } from '@cw/business-workflows';
import { HttpError } from '../agents.js';

/*
 * Business processes of Liquid Enterprise (ADR-0045) for the admin console: running and recent workflows of the
 * `business` namespace, holds by ontology object, pending approvals. Holding is tightening; releasing and deciding are
 * done by a signed-in person (Platform.Admin), audited by the routes.
 */

export interface ProcessRow {
  workflowId: string;
  type: string;
  status: string;
  startTime: string;
  closeTime: string | null;
  objects: string[];
  state: string | null;
  hold?: HoldState;
  approval?: ApprovalState;
}

const q = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const OBJECT = /^[A-Z][A-Za-z0-9]{1,80}:[A-Za-z0-9_.:-]{1,120}$/;

export class LiquidProcesses {
  constructor(private readonly client: () => Client | undefined) {}

  private c(): Client {
    const c = this.client();
    if (!c) throw new HttpError(503, 'Temporal is not connected');
    return c;
  }

  private async rows(query: string, limit: number): Promise<ProcessRow[]> {
    const out: ProcessRow[] = [];
    for await (const w of this.c().workflow.list({ query, pageSize: limit })) {
      out.push({
        workflowId: w.workflowId,
        type: w.type,
        status: w.status.name,
        startTime: w.startTime.toISOString(),
        closeTime: w.closeTime?.toISOString() ?? null,
        objects: (w.typedSearchAttributes.get(BSA.OntologyObjects) as string[] | undefined) ?? [],
        state: (w.typedSearchAttributes.get(BSA.BusinessState) as string | undefined) ?? null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async list() {
    const running = await this.rows("ExecutionStatus = 'Running'", 200);
    await Promise.all(
      running.map(async (r) => {
        const h = this.c().workflow.getHandle(r.workflowId);
        if (r.type === 'ApprovalWorkflow') r.approval = await h.query(approvalStateQuery).catch(() => undefined);
        if (r.type !== 'lakeFlush') r.hold = await h.query(holdStateQuery).catch(() => undefined);
      }),
    );
    const recent = (await this.rows("ExecutionStatus != 'Running' AND WorkflowType != 'lakeFlush'", 30)).sort((a, b) => (b.closeTime ?? '').localeCompare(a.closeTime ?? ''));
    return { running, recent, held: running.filter((r) => r.hold?.held).length, pendingApprovals: running.filter((r) => r.type === 'ApprovalWorkflow').length };
  }

  /** Holds every running workflow that touches one of the objects (e.g. Supplier:S-NORDHOLZ). */
  async hold(objects: string[], reason: string, ref: string) {
    if (!objects.length || objects.some((o) => !OBJECT.test(o))) throw new HttpError(400, 'objects must be like Class:id (e.g. Supplier:S-NORDHOLZ)');
    const held = new Set<string>();
    for (const o of objects) {
      for (const r of await this.rows(`${BSA.OntologyObjects.name} = ${q(o)} AND ExecutionStatus = 'Running' AND WorkflowType != 'lakeFlush'`, 500)) {
        await this.c().workflow.getHandle(r.workflowId).signal(holdSignal, { reason, ref });
        held.add(r.workflowId);
      }
    }
    return { ref, workflows: [...held].sort() };
  }

  /** Releases one hold (by its ref) everywhere it was placed. */
  async release(ref: string) {
    const released: string[] = [];
    for (const r of await this.rows("ExecutionStatus = 'Running' AND WorkflowType != 'lakeFlush'", 500)) {
      const h = this.c().workflow.getHandle(r.workflowId);
      const state = await h.query(holdStateQuery).catch(() => undefined);
      if (!state?.holds.some((x) => x.ref === ref)) continue;
      await h.signal(releaseSignal, { ref });
      released.push(r.workflowId);
    }
    return { ref, workflows: released.sort() };
  }

  async decide(workflowId: string, decision: 'approve' | 'reject', by: string, comment?: string) {
    try {
      return await this.c().workflow.getHandle(workflowId).executeUpdate(decideUpdate, { args: [{ decision, by, comment }] });
    } catch (err) {
      throw new HttpError(409, (err as Error).cause instanceof Error ? (err as Error & { cause: Error }).cause.message : (err as Error).message);
    }
  }
}
