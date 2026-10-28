import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { Role, TaskState, type AgentCard, type Task } from '@a2a-js/sdk';
import type { DelegationStatus, GatewayAgentConfig, GatewayConfig } from '@cw/shared';
import { DelegationQueue, isQueueId } from './delegationQueue.js';
import { decideDelegation } from './policy.js';

/*
 * A2A broker (ADR-0023): agents never talk to each other directly. The gateway resolves agent
 * cards and forwards `SendMessage` / `GetTask` with the official A2A client, authenticated with
 * the gateway token and the caller's identity (header `x-a2a-caller`).
 */

export interface SendTaskInput {
  title: string;
  instructions: string;
  type: 'analysis' | 'report' | 'change';
  approval: 'plan' | 'none' | 'deviation';
}

interface OpenDelegation {
  from: string;
  to: string;
  taskId: string;
  at: string;
}

const STATE: Record<number, DelegationStatus['state']> = {
  [TaskState.TASK_STATE_SUBMITTED]: 'submitted',
  [TaskState.TASK_STATE_WORKING]: 'working',
  [TaskState.TASK_STATE_INPUT_REQUIRED]: 'working',
  [TaskState.TASK_STATE_AUTH_REQUIRED]: 'working',
  [TaskState.TASK_STATE_COMPLETED]: 'completed',
  [TaskState.TASK_STATE_FAILED]: 'failed',
  [TaskState.TASK_STATE_CANCELED]: 'canceled',
  [TaskState.TASK_STATE_REJECTED]: 'rejected',
};

export class A2aBroker {
  private open: OpenDelegation[] = [];
  private readonly file: string;
  private configSource: () => GatewayConfig | undefined = () => undefined;
  /** Delegations that wait for earlier ones to complete (ADR-0036). */
  readonly queue: DelegationQueue;

  constructor(
    private readonly token: string,
    dataDir: string,
  ) {
    this.file = path.join(dataDir, 'a2a-open.json');
    const agent = (id: string) => this.configSource()?.agents.find((a) => a.agentId === id);
    this.queue = new DelegationQueue(path.join(dataDir, 'a2a-queued.json'), {
      remoteStatus: async (from, ref) => {
        const caller = agent(from);
        const peer = agent(ref.agentId);
        if (!caller || !peer) return { ...ref, state: 'unknown', terminal: true, summary: 'agent no longer exists' };
        return this.status(caller, peer, ref.taskId);
      },
      dispatch: async (q, instructions) => {
        const caller = agent(q.from);
        const peer = agent(q.to);
        if (!caller || !peer) throw new Error('agent no longer exists');
        const r = await this.sendRaw(caller, peer, { ...q.input, instructions }, { callerTaskId: q.callerTaskId, requestedBy: q.requestedBy });
        return { taskId: r.taskId };
      },
      blocked: async (q) => {
        const config = this.configSource();
        const caller = agent(q.from);
        if (!config || !caller) return 'the gateway configuration is not available';
        const d = decideDelegation(config, caller, q.to, await this.liveEdges());
        return d.allowed ? undefined : d.reason;
      },
    });
  }

  /** Where the broker reads the current agents, discovery sets and kill switches from (set by the gateway). */
  setConfigSource(fn: () => GatewayConfig | undefined) {
    this.configSource = fn;
  }

  async load() {
    this.open = JSON.parse(await readFile(this.file, 'utf8').catch(() => '[]')) as OpenDelegation[];
    await this.queue.load();
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.open, null, 2));
  }

  private openEdges(): Array<[string, string]> {
    return this.open.map((d) => [d.from, d.to]);
  }

  /**
   * Open and waiting delegation edges (caller → callee) for loop detection, **verified**: a recorded delegation counts only
   * while the task still exists at the colleague and has not finished. Records of tasks that are gone (agent deleted or
   * recreated, task purged) or finished are dropped, so a stale record can never block new work. An unreachable colleague
   * keeps its record (we cannot tell).
   */
  async liveEdges(): Promise<Array<[string, string]>> {
    const config = this.configSource();
    const keep: OpenDelegation[] = [];
    for (const d of [...this.open]) {
      const caller = config?.agents.find((a) => a.agentId === d.from);
      const peer = config?.agents.find((a) => a.agentId === d.to);
      if (!caller || !peer) continue; // an agent that no longer exists waits for nothing
      if (Date.now() - Date.parse(d.at) > 24 * 3_600_000) continue; // backstop: no real wait outlives a day without a decision
      try {
        const st = await Promise.race([this.status(caller, peer, d.taskId), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))]);
        if (!st.terminal) keep.push(d);
      } catch (err) {
        if (!/not ?found|-32001|unknown task/i.test(String(err))) keep.push(d);
      }
    }
    if (keep.length !== this.open.length) {
      this.open = keep;
      await this.persist();
    }
    return [...this.openEdges(), ...this.queue.edges()];
  }

  private factory(callerId: string) {
    const fetchImpl: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${this.token}`);
      headers.set('x-a2a-caller', callerId);
      return fetch(input, { ...init, headers });
    };
    return new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
        transports: [new JsonRpcTransportFactory({ fetchImpl })],
      }),
    );
  }

  async card(callerId: string, peer: GatewayAgentConfig): Promise<AgentCard> {
    const resolver = new DefaultAgentCardResolver({
      fetchImpl: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${this.token}`, 'x-a2a-caller': callerId } }),
    });
    return resolver.resolve(peer.url);
  }

  /** Delegate now. */
  async send(caller: GatewayAgentConfig, peer: GatewayAgentConfig, input: SendTaskInput, onBehalfOf: { callerTaskId?: string; requestedBy?: { upn: string; name: string; oid: string } }): Promise<{ taskId: string; state: string }> {
    const r = await this.sendRaw(caller, peer, input, onBehalfOf);
    await this.queue.remember(caller.agentId, { agentId: peer.agentId, taskId: r.taskId });
    return r;
  }

  /** Delegate later: the task starts when all tasks in `after` have completed, and receives their results (ADR-0036). */
  async sendAfter(caller: GatewayAgentConfig, peer: GatewayAgentConfig, input: SendTaskInput, onBehalfOf: { callerTaskId?: string; requestedBy?: { upn: string; name: string; oid: string } }, after: string[]): Promise<{ taskId: string; state: string }> {
    const q = await this.queue.add({ from: caller.agentId, to: peer.agentId, input, after, callerTaskId: onBehalfOf.callerTaskId, requestedBy: onBehalfOf.requestedBy });
    return { taskId: q.id, state: 'queued' };
  }

  private async sendRaw(caller: GatewayAgentConfig, peer: GatewayAgentConfig, input: SendTaskInput, onBehalfOf: { callerTaskId?: string; requestedBy?: { upn: string; name: string; oid: string } }): Promise<{ taskId: string; state: string }> {
    const client = await this.factory(caller.agentId).createFromUrl(peer.url);
    const result = await client.sendMessage({
      tenant: '',
      message: {
        messageId: randomUUID(),
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [{ content: { $case: 'text', value: input.instructions }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: { title: input.title, type: input.type, approval: input.approval, callerAgentId: caller.agentId, callerTaskId: onBehalfOf.callerTaskId, onBehalfOf: onBehalfOf.requestedBy },
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: { acceptedOutputModes: ['text'], taskPushNotificationConfig: undefined, returnImmediately: true },
      metadata: undefined,
    });
    if (!('status' in result)) throw new Error('The peer answered with a message instead of a task');
    const task = result as Task;
    this.open.push({ from: caller.agentId, to: peer.agentId, taskId: task.id, at: new Date().toISOString() });
    await this.persist();
    return { taskId: task.id, state: STATE[task.status?.state ?? 0] ?? 'unknown' };
  }

  async status(caller: GatewayAgentConfig, peer: GatewayAgentConfig, taskId: string): Promise<DelegationStatus> {
    if (isQueueId(taskId)) return this.queue.status(taskId);
    const client = await this.factory(caller.agentId).createFromUrl(peer.url);
    const task = await client.getTask({ tenant: '', id: taskId, historyLength: 0 });
    const state = STATE[task.status?.state ?? 0] ?? 'unknown';
    const terminal = ['completed', 'failed', 'canceled', 'rejected'].includes(state);
    const texts = task.artifacts.flatMap((a) => a.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : ''))).filter(Boolean);
    const statusText = task.status?.message?.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join(' ');
    if (terminal) {
      const before = this.open.length;
      this.open = this.open.filter((d) => !(d.to === peer.agentId && d.taskId === taskId));
      if (this.open.length !== before) await this.persist();
    }
    return { agentId: peer.agentId, taskId, state, terminal, summary: statusText?.slice(0, 1000), result: texts.join('\n\n').slice(0, 20_000) || undefined };
  }
}
