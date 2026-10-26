import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_GATEWAY_LIMITS, type GatewayConfig, type GatewayLimits, type UpstreamServer } from '@cw/shared';
import { logger } from './logger.js';
import type { KillSwitchService } from './killswitch.js';
import type { AgentRegistry } from './registry.js';
import type { AgentRuntime } from './runtime/types.js';

interface GatewayData {
  upstreams: UpstreamServer[];
  /** Tool allow-list per agent (patterns). Missing = nothing allowed. */
  allowedTools: Record<string, string[]>;
  limits: GatewayLimits;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Desired configuration of the MCP gateway; served to it and pushed on change (ADR-0021). */
export class GatewayConfigService {
  private data: GatewayData = { upstreams: [], allowedTools: {}, limits: DEFAULT_GATEWAY_LIMITS };
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly registry: AgentRegistry,
    private readonly runtime: AgentRuntime,
    private readonly killSwitch: KillSwitchService,
    private readonly gatewayUrl: string,
    private readonly gatewayToken: string,
  ) {
    this.file = path.join(dataDir, 'admin', 'gateway.json');
  }

  async load(defaults: Partial<GatewayData> = {}) {
    try {
      this.data = { ...this.data, ...(JSON.parse(await readFile(this.file, 'utf8')) as GatewayData) };
      // upstreams that were added to the platform later (e.g. "web") are registered once
      const missing = (defaults.upstreams ?? []).filter((u) => !this.data.upstreams.some((x) => x.name === u.name));
      if (missing.length) {
        this.data.upstreams = [...this.data.upstreams, ...missing];
        await this.persist();
      }
    } catch {
      this.data = { ...this.data, ...defaults };
      await this.persist();
    }
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    await rename(`${this.file}.tmp`, this.file);
  }

  get upstreams() {
    return this.data.upstreams;
  }

  allowedTools(agentId: string) {
    return this.data.allowedTools[agentId] ?? [];
  }

  async setUpstream(u: UpstreamServer) {
    this.data.upstreams = [...this.data.upstreams.filter((x) => x.name !== u.name), u].sort((a, b) => a.name.localeCompare(b.name));
    await this.persist();
    void this.push();
  }

  async deleteUpstream(name: string) {
    this.data.upstreams = this.data.upstreams.filter((x) => x.name !== name);
    await this.persist();
    void this.push();
  }

  async setAllowedTools(agentId: string, patterns: string[]) {
    this.data.allowedTools[agentId] = patterns;
    await this.persist();
    void this.push();
  }

  async removeAgent(agentId: string) {
    delete this.data.allowedTools[agentId];
    await this.persist();
    void this.push();
  }

  build(): GatewayConfig {
    return {
      generatedAt: new Date().toISOString(),
      killSwitch: this.killSwitch.get(),
      agents: this.registry.list().map((spec) => ({
        agentId: spec.agentId,
        displayName: spec.displayName,
        tokenSha256: sha256(this.registry.get(spec.agentId)!.secrets.internalToken),
        peers: spec.peers ?? [],
        allowedTools: this.allowedTools(spec.agentId),
        url: this.runtime.internalUrl(spec.agentId),
        obo: spec.entra?.enabled === true,
        oboAllowAgentOnly: spec.entra?.enabled === true && spec.entra.allowAgentOnly,
      })),
      upstreams: this.data.upstreams,
      limits: this.data.limits,
    };
  }

  /** Ask the gateway to re-sync now (otherwise it polls every few seconds). */
  async push() {
    try {
      await fetch(`${this.gatewayUrl}/internal/refresh`, { method: 'POST', headers: { authorization: `Bearer ${this.gatewayToken}` }, signal: AbortSignal.timeout(3000) });
    } catch (err) {
      logger.debug({ err: String(err) }, 'gateway not reachable for push');
    }
  }

  async gatewayCall<T>(pathAndQuery: string): Promise<T | undefined> {
    try {
      const res = await fetch(`${this.gatewayUrl}${pathAndQuery}`, { headers: { authorization: `Bearer ${this.gatewayToken}` }, signal: AbortSignal.timeout(5000) });
      return res.ok ? ((await res.json()) as T) : undefined;
    } catch {
      return undefined;
    }
  }
}
