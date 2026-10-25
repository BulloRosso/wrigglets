import { Client, Connection, WorkflowNotFoundError, type WorkflowExecutionInfo } from '@temporalio/client';
import { msToTs } from '@temporalio/common/lib/time.js';
import { AesGcmCodec } from '@cw/codec';
import { agentWorkflowId, type AgentStatus, type TaskListItem } from '@cw/shared';
import { SA, SEARCH_ATTRIBUTE_CLI_DEFINITIONS, q } from '@cw/shared/search-attributes';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

const INDEXED_TYPE: Record<string, number> = { Text: 1, Keyword: 2, Int: 3, Double: 4, Bool: 5, Datetime: 6, KeywordList: 7 };

/** Temporal access of the control plane: health, namespace bootstrap, per-agent views. */
export class TemporalPlatform {
  client?: Client;
  readonly codec: AesGcmCodec;
  version?: string;

  constructor(private readonly config: Config) {
    this.codec = AesGcmCodec.fromSpec(config.PAYLOAD_CODEC_KEYS);
  }

  async connect(timeoutMs = 120_000): Promise<Client> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const connection = await Connection.connect({ address: this.config.TEMPORAL_ADDRESS, connectTimeout: 3000 });
        const info = await connection.workflowService.getSystemInfo({});
        this.version = info.serverVersion ?? undefined;
        this.client = new Client({ connection, namespace: this.config.TEMPORAL_NAMESPACE, dataConverter: { payloadCodecs: [this.codec] } });
        return this.client;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Idempotent namespace bootstrap (same intent as infra/temporal/bootstrap.sh on Azure). */
  async bootstrap(): Promise<void> {
    const conn = this.client!.connection;
    const namespace = this.config.TEMPORAL_NAMESPACE;
    const retention = msToTs(this.config.TEMPORAL_RETENTION_DAYS * 86_400_000);
    try {
      await conn.workflowService.describeNamespace({ namespace });
    } catch {
      await conn.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: retention });
      logger.info({ namespace }, 'namespace registered');
    }
    await conn.workflowService.updateNamespace({ namespace, config: { workflowExecutionRetentionTtl: retention } }).catch((err: unknown) => logger.warn({ err: String(err) }, 'could not update retention'));
    const existing = await conn.operatorService.listSearchAttributes({ namespace });
    const known = new Set(Object.keys(existing.customAttributes ?? {}));
    const missing = SEARCH_ATTRIBUTE_CLI_DEFINITIONS.filter(([name]) => !known.has(name));
    if (missing.length) {
      await conn.operatorService.addSearchAttributes({ namespace, searchAttributes: Object.fromEntries(missing.map(([n, t]) => [n, INDEXED_TYPE[t]!])) });
      logger.info({ added: missing.map(([n]) => n) }, 'search attributes registered');
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client!.connection.workflowService.describeNamespace({ namespace: this.config.TEMPORAL_NAMESPACE });
      return true;
    } catch {
      return false;
    }
  }

  async agentLock(agentId: string): Promise<AgentStatus | undefined> {
    try {
      return await this.client!.workflow.getHandle(agentWorkflowId(agentId)).query<AgentStatus>('status');
    } catch {
      return undefined;
    }
  }

  async count(query: string): Promise<number> {
    try {
      return (await this.client!.workflow.count(query)).count;
    } catch {
      let n = 0;
      for await (const _ of this.client!.workflow.list({ query })) if (++n >= 1000) break;
      return n;
    }
  }

  async tasks(query: string, limit = 25): Promise<Array<TaskListItem & { agentId: string }>> {
    const out: Array<TaskListItem & { agentId: string }> = [];
    for await (const w of this.client!.workflow.list({ query, pageSize: limit })) {
      out.push(toItem(w));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Removes an agent's schedules and terminates its running workflows (agent deletion with purge). */
  async purgeAgent(agentId: string, reason: string): Promise<{ schedules: number; workflows: number }> {
    const client = this.client!;
    let schedules = 0;
    let workflows = 0;
    for await (const s of client.schedule.list()) {
      if (s.scheduleId.startsWith(`sched-${agentId}-`) || s.scheduleId.startsWith(`sched-sys-${agentId}-`)) {
        await client.schedule.getHandle(s.scheduleId).delete();
        schedules += 1;
      }
    }
    for await (const w of client.workflow.list({ query: `AgentId = ${q(agentId)} AND ExecutionStatus = 'Running'` })) {
      await client.workflow.getHandle(w.workflowId).terminate(reason).catch((err) => {
        if (!(err instanceof WorkflowNotFoundError)) throw err;
      });
      workflows += 1;
    }
    return { schedules, workflows };
  }
}

function toItem(w: WorkflowExecutionInfo): TaskListItem & { agentId: string } {
  const sa = w.typedSearchAttributes;
  return {
    agentId: sa.get(SA.AgentId) ?? '',
    taskId: w.workflowId,
    runId: w.runId,
    title: sa.get(SA.TaskTitle) ?? w.workflowId,
    type: (sa.get(SA.TaskType) ?? 'analysis') as TaskListItem['type'],
    status: sa.get(SA.TaskStatus) ?? w.status.name.toLowerCase(),
    requestedBy: sa.get(SA.RequestedBy) ?? '',
    trigger: sa.get(SA.Trigger) ?? 'user',
    scheduleId: sa.get(SA.ScheduleId),
    approvedBy: sa.get(SA.ApprovedBy) ?? [],
    startTime: w.startTime.toISOString(),
    closeTime: w.closeTime?.toISOString(),
    workflowStatus: w.status.name,
  };
}
