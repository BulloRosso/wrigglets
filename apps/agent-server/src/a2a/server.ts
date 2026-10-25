import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Express } from 'express';
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, Role, TaskState, type AgentCard, type Message, type Task } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type ServerCallContext,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { Identity, Principal, TaskState as CwTaskState } from '@cw/shared';
import { cancelUpdate, taskStateQuery } from '@cw/workflows/messages';
import type { ApiDeps } from '../api/context.js';
import { startTaskWorkflow } from '../api/routes/tasks.js';
import { logger } from '../logger.js';

/*
 * A2A server of this agent (ADR-0023), built on the official A2A SDK (protocol v1.0, JSON-RPC).
 * Only the MCP gateway may call it (bearer A2A_GATEWAY_TOKEN, caller in `x-a2a-caller`).
 * Every incoming message becomes a normal, audited TaskWorkflow `task-a2a-<a2a task id>`;
 * the task store reads the live state from Temporal.
 */

export const workflowIdFor = (a2aTaskId: string) => `task-a2a-${a2aTaskId}`;

const textPart = (value: string) => ({ content: { $case: 'text' as const, value }, metadata: undefined, filename: '', mediaType: 'text/plain' });

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return { messageId: randomUUID(), contextId, taskId, role: Role.ROLE_AGENT, parts: [textPart(text)], metadata: {}, extensions: [], referenceTaskIds: [] };
}

const STATE: Record<string, TaskState> = {
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  budget_exceeded: TaskState.TASK_STATE_FAILED,
  expired: TaskState.TASK_STATE_FAILED,
  rejected: TaskState.TASK_STATE_REJECTED,
  cancelled: TaskState.TASK_STATE_CANCELED,
};

class TemporalTaskStore extends InMemoryTaskStore {
  constructor(private readonly deps: ApiDeps) {
    super();
  }

  override async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const base = await super.load(taskId, context);
    let state: CwTaskState;
    try {
      state = await this.deps.temporal.workflow.getHandle(workflowIdFor(taskId)).query(taskStateQuery);
    } catch {
      return base;
    }
    const contextId = base?.contextId ?? '';
    const a2aState = STATE[state.status] ?? TaskState.TASK_STATE_WORKING;
    const statusText =
      state.status === 'awaiting_approval'
        ? `Waiting for approval (${state.awaiting ?? 'plan'}) at ${this.deps.config.AGENT_DISPLAY_NAME}.`
        : state.status === 'completed'
          ? (state.result?.summary ?? 'Completed.')
          : `${state.status}${state.error ? `: ${state.error}` : ''}`;
    const artifacts = state.status === 'completed' ? await this.artifacts(state) : [];
    return {
      id: taskId,
      contextId,
      status: { state: a2aState, timestamp: new Date().toISOString(), message: agentMessage(taskId, contextId, statusText) },
      artifacts,
      history: base?.history ?? [],
      metadata: { workflowId: workflowIdFor(taskId), agentId: this.deps.config.AGENT_ID, status: state.status },
    };
  }

  /** Result summary plus the content of the produced reports (bounded). */
  private async artifacts(state: CwTaskState): Promise<Task['artifacts']> {
    const parts = [textPart(state.result?.summary ?? '')];
    let budget = 200_000;
    for (const out of (state.result?.outputs ?? []).filter((o) => o.startsWith('reports/')).slice(0, 5)) {
      const text = await readFile(path.join(this.deps.config.workspaceDir, out), 'utf8').catch(() => '');
      if (!text || text.length > budget) continue;
      budget -= text.length;
      parts.push({ ...textPart(text), filename: out, mediaType: 'text/markdown' });
    }
    return [{ artifactId: `${state.taskId}-result`, name: 'Result', description: state.title, parts, metadata: undefined, extensions: [] }];
  }
}

class TaskWorkflowExecutor implements AgentExecutor {
  constructor(private readonly deps: ApiDeps) {}

  async execute(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const msg = rc.userMessage;
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    const caller = String(meta.callerAgentId ?? 'unknown');
    const text = msg.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('\n').trim();
    const onBehalfOf = (meta.onBehalfOf as Identity | undefined) ?? { upn: `agent-${caller}@agents.local`, name: `Agent ${caller}`, oid: `agent-${caller}` };
    const requester: Principal = { ...onBehalfOf, roles: [] };
    const workflowId = workflowIdFor(rc.taskId);
    const type = ['analysis', 'report', 'change'].includes(String(meta.type)) ? (meta.type as 'analysis' | 'report' | 'change') : 'report';
    const approval = ['plan', 'none', 'deviation'].includes(String(meta.approval)) ? (meta.approval as 'plan' | 'none' | 'deviation') : 'plan';
    await startTaskWorkflow(
      this.deps,
      requester,
      {
        title: String(meta.title ?? text.slice(0, 80)).slice(0, 120),
        instructions: `${text}\n\n(Delegated via A2A by agent "${caller}" on behalf of ${onBehalfOf.name} <${onBehalfOf.upn}>.)`,
        type,
        approval,
        budget: { maxTokens: this.deps.config.TASK_DEFAULT_TOKEN_BUDGET },
      },
      { taskId: workflowId, trigger: { kind: 'agent', callerAgentId: caller, callerTaskId: meta.callerTaskId ? String(meta.callerTaskId) : undefined, a2aTaskId: rc.taskId } },
    );
    logger.info({ a2aTaskId: rc.taskId, workflowId, caller }, 'A2A task accepted');
    bus.publish(
      AgentEvent.task({
        id: rc.taskId,
        contextId: rc.contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
        artifacts: [],
        history: [msg],
        metadata: { workflowId },
      }),
    );
    bus.publish(
      AgentEvent.statusUpdate({
        taskId: rc.taskId,
        contextId: rc.contextId,
        status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: agentMessage(rc.taskId, rc.contextId, `Accepted as ${workflowId}`) },
        metadata: {},
      }),
    );
    bus.finished();
  }

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    try {
      await this.deps.temporal.workflow
        .getHandle(workflowIdFor(taskId))
        .executeUpdate(cancelUpdate, { args: [{ by: { upn: 'a2a-caller', name: 'Delegating agent', oid: 'a2a', roles: [] }, reason: 'cancelled by the delegating agent' }] });
    } catch (err) {
      logger.warn({ taskId, err: String(err) }, 'A2A cancel failed');
    }
    bus.publish(AgentEvent.statusUpdate({ taskId, contextId: '', status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined }, metadata: {} }));
    bus.finished();
  };
}

export function mountA2a(app: Express, deps: ApiDeps) {
  const c = deps.config;
  if (!c.A2A_GATEWAY_TOKEN) return;
  const internalBase = `http://agent-${c.AGENT_ID}:8080`;
  const card: AgentCard = {
    name: c.AGENT_DISPLAY_NAME,
    description: c.AGENT_DESCRIPTION || `AI colleague ${c.AGENT_DISPLAY_NAME}`,
    supportedInterfaces: [{ url: `${internalBase}/a2a`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: 'Coworking Agents', url: c.publicBaseUrl },
    version: c.version,
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'task-status'],
    skills: [
      { id: 'report', name: 'Report', description: 'Produce a report from the shared workspace', tags: ['report'], examples: [], inputModes: ['text'], outputModes: ['text'], securityRequirements: [] },
      { id: 'analysis', name: 'Analysis', description: 'Analyse data in the workspace', tags: ['analysis'], examples: [], inputModes: ['text'], outputModes: ['text'], securityRequirements: [] },
      { id: 'change', name: 'Change', description: 'Change team data in the workspace', tags: ['change'], examples: [], inputModes: ['text'], outputModes: ['text'], securityRequirements: [] },
    ],
    documentationUrl: '',
    signatures: [],
  };
  const handler = new DefaultRequestHandler(card, new TemporalTaskStore(deps), new TaskWorkflowExecutor(deps));
  const gatewayOnly: express.RequestHandler = (req, res, next) => {
    if (req.header('authorization') !== `Bearer ${c.A2A_GATEWAY_TOKEN}` || !req.header('x-a2a-caller')) {
      res.status(401).json({ error: 'A2A is only available through the MCP gateway' });
      return;
    }
    next();
  };
  app.use(`/${AGENT_CARD_PATH}`, gatewayOnly, agentCardHandler({ agentCardProvider: handler }));
  app.use('/a2a', gatewayOnly, jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
}
