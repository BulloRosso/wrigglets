import type { GatewayConfig } from '@cw/shared';
import type { Logger } from 'pino';

/**
 * Pulls the effective configuration (agents, discovery sets, allow-lists, upstreams, kill switch)
 * from the control plane. A push endpoint triggers an immediate refresh after admin changes.
 */
export class ConfigSync {
  config?: GatewayConfig;
  lastSync = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly intervalMs: number,
    private readonly maxStalenessMs: number,
    private readonly log: Logger,
  ) {}

  get stale(): boolean {
    return Date.now() - this.lastSync > this.maxStalenessMs;
  }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/internal/gateway-config`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`control plane returned ${res.status}`);
      const wasStale = this.stale;
      this.config = (await res.json()) as GatewayConfig;
      this.lastSync = Date.now();
      if (wasStale) this.log.info({ agents: this.config.agents.length, upstreams: this.config.upstreams.length }, 'configuration in sync');
      return true;
    } catch (err) {
      if (!this.stale) return false;
      this.log.warn({ err: String(err) }, 'configuration stale — tools disabled (fail-closed)');
      return false;
    }
  }
}
