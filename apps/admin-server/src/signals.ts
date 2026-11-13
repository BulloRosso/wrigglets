import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_SIGNALS_AGENT_CONFIG,
  observationBody,
  signalsAgentConfig,
  signalsConnectors,
  signalsHttpSource,
  type SignalsAgentConfig,
  type SignalsConnectors,
  type SignalsHubConfig,
} from '@cw/shared';
import type { KillSwitchService } from './killswitch.js';
import { logger } from './logger.js';
import type { AdminAudit, AgentRegistry } from './registry.js';
import type { AgentRuntime } from './runtime/types.js';

/*
 * Signals on the control plane (optional module, ADR-0037). Owns
 *   - the per-agent settings (switched on/off, brief, owner, default action, thresholds) that agents fetch,
 *   - the connectors of the signals hub (HTTP sources, IMAP accounts, MQTT brokers) that the hub polls,
 * and forwards observations from the hub to the agent containers (agents are never reached by the hub directly).
 * Credentials of connectors are Key Vault references; HTTP source tokens are stored as SHA-256 only.
 */

export const signalsState = z.object({
  connectors: signalsConnectors.default({ http: [], imap: [], mqtt: [] }),
  agents: z.record(z.string(), signalsAgentConfig).default({}),
});
export type SignalsStateFile = z.output<typeof signalsState>;

export class SignalsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const forwardObservationBody = observationBody.extend({
  agentId: z.string().min(1).max(40),
  by: z.string().trim().min(1).max(200),
});

export class SignalsControlService {
  private state: SignalsStateFile = { connectors: { http: [], imap: [], mqtt: [] }, agents: {} };
  private readonly file: string;
  private writing = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly registry: Pick<AgentRegistry, 'get' | 'list'>,
    private readonly runtime: Pick<AgentRuntime, 'internalUrl'>,
    private readonly killSwitch: Pick<KillSwitchService, 'effective'>,
    private readonly audit: Pick<AdminAudit, 'write'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.file = path.join(dataDir, 'admin', 'signals.json');
  }

  async load() {
    try {
      this.state = signalsState.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      this.state = signalsState.parse({});
    }
  }

  private persist() {
    const data = JSON.stringify(this.state, null, 2);
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, data);
      await rename(`${this.file}.tmp`, this.file);
    });
    return this.writing;
  }

  /* ------------------------------------------------------------ per-agent settings */

  agentConfig(agentId: string): SignalsAgentConfig {
    return this.state.agents[agentId] ?? DEFAULT_SIGNALS_AGENT_CONFIG;
  }

  async setAgentConfig(agentId: string, input: unknown, by: string): Promise<SignalsAgentConfig> {
    if (!this.registry.get(agentId)) throw new SignalsError(404, 'agent not found');
    const before = this.agentConfig(agentId);
    const next = signalsAgentConfig.parse(input);
    this.state.agents[agentId] = next;
    await this.persist();
    await this.audit.write({
      by,
      action: 'signals.agent',
      target: agentId,
      details: { enabled: next.enabled, owner: next.owner?.upn, defaultAction: next.defaultAction, fulfilThreshold: next.fulfilThreshold, briefChanged: before.brief !== next.brief, wasEnabled: before.enabled },
    });
    return next;
  }

  enabledAgents(): string[] {
    return this.registry
      .list()
      .map((s) => s.agentId)
      .filter((id) => this.agentConfig(id).enabled);
  }

  /* ------------------------------------------------------------ connectors */

  connectors(): SignalsConnectors {
    return this.state.connectors;
  }

  /** Replaces IMAP and MQTT connectors (HTTP sources are managed with their own calls because of their tokens). */
  async setConnectors(input: unknown, by: string): Promise<SignalsConnectors> {
    const parsed = signalsConnectors.parse({ ...(input as object), http: this.state.connectors.http });
    this.assertUnique(parsed);
    this.state.connectors = parsed;
    await this.persist();
    await this.audit.write({ by, action: 'signals.connectors', target: '*', details: { imap: parsed.imap.map((a) => `${a.id}→${a.agentId}`), mqtt: parsed.mqtt.map((b) => `${b.id} (${b.subscriptions.length} topics)`) } });
    return parsed;
  }

  /** Creates an HTTP ingest source and returns its token ONCE (only the SHA-256 is kept). */
  async createHttpSource(id: string, agentId: string, by: string): Promise<{ id: string; token: string }> {
    if (!this.registry.get(agentId)) throw new SignalsError(404, 'agent not found');
    if (this.state.connectors.http.some((s) => s.id === id)) throw new SignalsError(409, `HTTP source ${id} exists`);
    const token = `sig_${randomBytes(24).toString('base64url')}`;
    const source = signalsHttpSource.parse({ id, agentId, tokenSha256: createHash('sha256').update(token).digest('hex'), enabled: true });
    const next = { ...this.state.connectors, http: [...this.state.connectors.http, source] };
    this.assertUnique(next);
    this.state.connectors = next;
    await this.persist();
    await this.audit.write({ by, action: 'signals.http.create', target: id, details: { agentId } });
    return { id, token };
  }

  async deleteHttpSource(id: string, by: string) {
    const before = this.state.connectors.http.length;
    this.state.connectors = { ...this.state.connectors, http: this.state.connectors.http.filter((s) => s.id !== id) };
    if (this.state.connectors.http.length === before) throw new SignalsError(404, 'HTTP source not found');
    await this.persist();
    await this.audit.write({ by, action: 'signals.http.delete', target: id });
  }

  private assertUnique(c: SignalsConnectors) {
    const ids = [...c.http.map((s) => s.id), ...c.imap.map((s) => s.id), ...c.mqtt.map((s) => s.id)];
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new SignalsError(400, `Connector id "${dup}" is used twice`);
  }

  /** What the hub polls. The version changes whenever the content changes. */
  hubConfig(): SignalsHubConfig {
    const body = { connectors: this.state.connectors, agents: this.enabledAgents() };
    const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    return { version, ...body };
  }

  /* ------------------------------------------------------------ forwarding to agents */

  /** Calls an agent's `/internal/signals/*` route with its control-plane token. */
  async callAgent(agentId: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const entry = this.registry.get(agentId);
    if (!entry) throw new SignalsError(404, `unknown agent ${agentId}`);
    if (!this.agentConfig(agentId).enabled) throw new SignalsError(409, `Signals is not switched on for ${agentId}`);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.runtime.internalUrl(agentId)}/internal/signals${route}`, {
        method,
        headers: { authorization: `Bearer ${entry.secrets.internalToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.warn({ agentId, err: String(err) }, 'agent not reachable for signals');
      // 503: the hub keeps the observation in its outbox and retries
      throw new SignalsError(503, `agent ${agentId} is not reachable`);
    }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  /** Observation from the hub → agent. Refused (and kept in the hub's outbox) while the agent is paused or stopped. */
  async forwardObservation(input: unknown): Promise<{ status: number; json: unknown }> {
    const { agentId, ...observation } = forwardObservationBody.parse(input);
    const level = this.killSwitch.effective(agentId).level;
    if (level === 'paused' || level === 'stopped') throw new SignalsError(503, `agent ${agentId} is ${level}`);
    return this.callAgent(agentId, 'POST', '/observe', observation);
  }
}
