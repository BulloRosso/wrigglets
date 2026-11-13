import { createHash, timingSafeEqual } from 'node:crypto';
import type { SignalsConnectorStatus, SignalsHubConfig, SignalsHubStatus, SignalsHttpSource } from '@cw/shared';
import { ImapConnector } from './imap.js';
import { MqttConnector, type Emit } from './mqtt.js';
import type { DeliveryResult, Outbox, OutboxEntry } from './outbox.js';

/*
 * The hub's moving parts: configuration from the control plane (polled, like the MCP gateway does), the connectors
 * built from it, HTTP source authentication and delivery of outbox entries to the control plane.
 */

export interface HubOptions {
  controlPlaneUrl: string;
  token: string;
  secret: (name: string) => Promise<string>;
  outbox: Outbox;
  fetch?: typeof fetch;
}

type Connector = ImapConnector | MqttConnector;

export class Hub {
  config?: SignalsHubConfig;
  configAt?: string;
  configError?: string;
  private connectors: Connector[] = [];
  private readonly httpStats = new Map<string, { observations: number; lastObservationAt?: string }>();

  constructor(private readonly o: HubOptions) {}

  private f() {
    return this.o.fetch ?? fetch;
  }

  /** Queues an observation for an agent with Signals switched on. */
  readonly emit: Emit = async (agentId, observation, by) => {
    if (this.config && !this.config.agents.includes(agentId)) throw new HubError(409, `Signals is not switched on for ${agentId}`);
    return this.o.outbox.add(agentId, observation, by);
  };

  /* ------------------------------------------------------------ configuration */

  async syncOnce(): Promise<boolean> {
    try {
      const res = await this.f()(`${this.o.controlPlaneUrl}/internal/signals-config`, { headers: { authorization: `Bearer ${this.o.token}` }, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`control plane returned ${res.status}`);
      const next = (await res.json()) as SignalsHubConfig;
      this.configAt = new Date().toISOString();
      this.configError = undefined;
      if (next.version === this.config?.version) return false;
      this.config = next;
      await this.reconcile();
      return true;
    } catch (err) {
      this.configError = String(err instanceof Error ? err.message : err).slice(0, 300);
      return false;
    }
  }

  startSync(intervalMs = 10_000) {
    void this.syncOnce();
    setInterval(() => void this.syncOnce(), intervalMs).unref();
  }

  /** Rebuilds all connectors (simple and safe: configuration changes are rare). */
  private async reconcile() {
    await Promise.all(this.connectors.map((c) => c.stop()));
    const c = this.config!.connectors;
    this.connectors = [
      ...c.imap.map((a) => new ImapConnector(a, this.emit, () => this.o.secret(a.passwordRef))),
      ...c.mqtt.map((b) => new MqttConnector(b, this.emit, async () => (b.passwordRef ? this.o.secret(b.passwordRef) : undefined))),
    ];
    for (const conn of this.connectors) await conn.start().catch(() => undefined);
  }

  async stop() {
    await Promise.all(this.connectors.map((c) => c.stop()));
  }

  /* ------------------------------------------------------------ HTTP sources */

  httpSource(bearer: string): SignalsHttpSource | undefined {
    if (!bearer) return undefined;
    const hash = Buffer.from(createHash('sha256').update(bearer).digest('hex'));
    return this.config?.connectors.http.find((s) => {
      const h = Buffer.from(s.tokenSha256);
      return s.enabled && h.length === hash.length && timingSafeEqual(h, hash);
    });
  }

  countHttp(id: string) {
    const s = this.httpStats.get(id) ?? { observations: 0 };
    s.observations += 1;
    s.lastObservationAt = new Date().toISOString();
    this.httpStats.set(id, s);
  }

  /* ------------------------------------------------------------ delivery (outbox → control plane → agent) */

  readonly deliver = async (e: OutboxEntry): Promise<DeliveryResult> => {
    let res: Response;
    try {
      res = await this.f()(`${this.o.controlPlaneUrl}/internal/signals/observations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...e.observation, agentId: e.agentId, by: e.by }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { outcome: 'retry', error: `control plane not reachable: ${String(err)}`.slice(0, 300) };
    }
    if (res.status === 200 || res.status === 202) return { outcome: 'delivered' };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const error = `${res.status}: ${body.error ?? 'refused'}`.slice(0, 300);
    // 400 = invalid observation, 404 = unknown agent: retrying cannot help. 409 (switched off), 429, 5xx: retry.
    return res.status === 400 || res.status === 404 ? { outcome: 'drop', error } : { outcome: 'retry', error };
  };

  /* ------------------------------------------------------------ status for the admin console */

  status(): SignalsHubStatus {
    const http: SignalsConnectorStatus[] = (this.config?.connectors.http ?? []).map((s) => ({
      id: s.id,
      kind: 'http',
      state: s.enabled ? 'up' : 'disabled',
      observations: this.httpStats.get(s.id)?.observations ?? 0,
      lastObservationAt: this.httpStats.get(s.id)?.lastObservationAt,
    }));
    return {
      configVersion: this.config?.version,
      configAt: this.configAt,
      outbox: this.o.outbox.status(),
      connectors: [...http, ...this.connectors.map((c) => ({ ...c.status }))],
      ...(this.configError ? { configError: this.configError } : {}),
    } as SignalsHubStatus;
  }

  /* ------------------------------------------------------------ calls for the MCP tools (through the control plane) */

  async controlPlane(method: 'GET' | 'POST', route: string, body?: unknown): Promise<unknown> {
    const res = await this.f()(`${this.o.controlPlaneUrl}/internal/signals${route}`, {
      method,
      headers: { authorization: `Bearer ${this.o.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new HubError(res.status, json.error ?? `control plane returned ${res.status}`);
    return json;
  }
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
