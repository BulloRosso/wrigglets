import { createHash } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import type { ObservationInput, SignalsConnectorStatus, SignalsMqttBroker } from '@cw/shared';

/*
 * MQTT connector: one client per broker; each subscription routes its topic (with + and # wildcards) to one agent.
 * Messages on the same topic within `debounceSeconds` are folded (the last one wins), at most `maxPerHour` observations
 * per subscription, payloads above `maxPayloadBytes` are cut. Machine messages are frequent: the limits keep the
 * model cost bounded.
 */

export type Emit = (agentId: string, o: ObservationInput, by: string) => Promise<unknown>;

/** MQTT topic filter match (`+` one level, `#` the rest). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

type Sub = SignalsMqttBroker['subscriptions'][number];

/** Debounce + hourly limit per subscription; independent of the network part (unit-tested). */
export class MqttRouter {
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; payload: Buffer }>();
  private readonly sent = new Map<number, number[]>();
  dropped = 0;

  constructor(
    private readonly brokerId: string,
    private readonly subs: Sub[],
    private readonly emit: Emit,
    private readonly onObservation: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  handle(topic: string, payload: Buffer) {
    this.subs.forEach((s, i) => {
      if (!topicMatches(s.topic, topic)) return;
      const key = `${i}|${topic}`;
      const old = this.pending.get(key);
      if (old) clearTimeout(old.timer);
      const fire = () => {
        this.pending.delete(key);
        this.send(i, s, topic, payload);
      };
      if (s.debounceSeconds <= 0) fire();
      else this.pending.set(key, { timer: setTimeout(fire, s.debounceSeconds * 1000), payload });
    });
  }

  private send(i: number, s: Sub, topic: string, payload: Buffer) {
    const now = this.now();
    const times = (this.sent.get(i) ?? []).filter((t) => t > now - 3_600_000);
    if (times.length >= s.maxPerHour) {
      this.dropped += 1;
      this.sent.set(i, times);
      return;
    }
    times.push(now);
    this.sent.set(i, times);
    const text = payload.subarray(0, s.maxPayloadBytes).toString('utf8');
    const o: ObservationInput = {
      source: 'mqtt',
      ref: `${topic}#${createHash('sha256').update(payload).digest('hex').slice(0, 16)}#${Math.floor(now / 1000)}`,
      subject: `MQTT ${topic}`,
      from: `mqtt:${this.brokerId}`,
      body: payload.length > s.maxPayloadBytes ? `${text}\n[… payload cut at ${s.maxPayloadBytes} bytes]` : text || '(empty message)',
      receivedAt: new Date(now).toISOString(),
      reportedBy: `mqtt:${this.brokerId}`,
    };
    this.onObservation();
    void this.emit(s.agentId, o, `mqtt:${this.brokerId}`).catch(() => undefined);
  }

  stop() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}

export class MqttConnector {
  private client?: MqttClient;
  private router?: MqttRouter;
  readonly status: SignalsConnectorStatus;

  constructor(
    private readonly broker: SignalsMqttBroker,
    private readonly emit: Emit,
    private readonly password: () => Promise<string | undefined>,
  ) {
    this.status = { id: broker.id, kind: 'mqtt', state: broker.enabled ? 'connecting' : 'disabled', observations: 0 };
  }

  async start() {
    if (!this.broker.enabled) return;
    const password = this.broker.passwordRef ? await this.password().catch((err: unknown) => {
      this.status.state = 'down';
      this.status.lastError = `password ${this.broker.passwordRef} not readable: ${String(err)}`.slice(0, 300);
      return undefined;
    }) : undefined;
    if (this.broker.passwordRef && password === undefined) return;
    this.router = new MqttRouter(this.broker.id, this.broker.subscriptions, this.emit, () => {
      this.status.observations += 1;
      this.status.lastObservationAt = new Date().toISOString();
    });
    this.client = mqtt.connect(this.broker.url, {
      username: this.broker.username,
      password,
      clientId: `cw-signals-${this.broker.id}`,
      reconnectPeriod: 10_000,
      connectTimeout: 15_000,
    });
    this.client.on('connect', () => {
      this.status.state = 'up';
      this.status.lastError = undefined;
      const topics = [...new Set(this.broker.subscriptions.map((s) => s.topic))];
      if (topics.length) this.client!.subscribe(topics, { qos: 1 }, (err) => err && (this.status.lastError = String(err).slice(0, 300)));
    });
    this.client.on('error', (err) => {
      this.status.state = 'down';
      this.status.lastError = String(err).slice(0, 300);
    });
    this.client.on('offline', () => (this.status.state = 'down'));
    this.client.on('message', (topic, payload) => this.router!.handle(topic, payload));
  }

  async stop() {
    this.router?.stop();
    await this.client?.endAsync(true).catch(() => undefined);
  }
}
