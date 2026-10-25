import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_HARDENING_ENV, renderHarnessConfig } from '@cw/harness-config';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { metrics } from '../telemetry.js';

export type HarnessState = 'starting' | 'up' | 'down';

/**
 * Runs the Agent Harness (`opencode serve`) as a supervised child process (spec §5.4, §6.1):
 * bound to 127.0.0.1, random per-boot password, config outside the workspace, restart with
 * exponential backoff (1 s → 30 s).
 */
export class HarnessSupervisor {
  readonly password = randomBytes(32).toString('hex');
  readonly baseUrl: string;
  state: HarnessState = 'starting';
  version?: string;
  downSince?: Date;
  restarts = 0;
  private child?: ChildProcess;
  private stopping = false;
  private backoffMs = 1000;
  private healthTimer?: NodeJS.Timeout;
  private listeners = new Set<(s: HarnessState) => void>();

  constructor(private readonly config: Config) {
    this.baseUrl = `http://127.0.0.1:${config.HARNESS_PORT}`;
  }

  get authHeader(): string {
    return `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`;
  }

  onStateChange(fn: (s: HarnessState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Boot step 4: render the harness config (only rewritten when changed). */
  async writeConfig(): Promise<void> {
    const cfg = renderHarnessConfig({
      workspaceDir: this.config.workspaceDir,
      model: this.config.AI_GATEWAY_MODEL,
      smallModel: this.config.AI_GATEWAY_SMALL_MODEL,
      mcpGatewayUrl: this.config.MCP_GATEWAY_URL,
    });
    const content = `${JSON.stringify(cfg, null, 2)}\n`;
    await mkdir(path.dirname(this.config.HARNESS_CONFIG_PATH), { recursive: true });
    const current = await readFile(this.config.HARNESS_CONFIG_PATH, 'utf8').catch(() => '');
    if (current !== content) {
      await writeFile(this.config.HARNESS_CONFIG_PATH, content, { mode: 0o600 });
      logger.info({ path: this.config.HARNESS_CONFIG_PATH }, 'harness config written');
    }
  }

  async start(): Promise<void> {
    await this.writeConfig();
    await mkdir(this.config.HARNESS_HOME, { recursive: true });
    this.spawnChild();
    this.healthTimer = setInterval(() => void this.checkHealth(), 10_000);
  }

  private spawnChild() {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      HOME: this.config.HARNESS_HOME,
      XDG_DATA_HOME: this.config.harnessDataDir,
      OPENCODE_CONFIG: this.config.HARNESS_CONFIG_PATH,
      OPENCODE_SERVER_PASSWORD: this.password,
      AI_GATEWAY_BASE_URL: this.config.AI_GATEWAY_BASE_URL,
      AI_GATEWAY_API_KEY: this.config.AI_GATEWAY_API_KEY,
      ...(this.config.MCP_GATEWAY_TOKEN ? { MCP_GATEWAY_TOKEN: this.config.MCP_GATEWAY_TOKEN } : {}),
      ...HARNESS_HARDENING_ENV,
    };
    this.setState('starting');
    const child = spawn(this.config.HARNESS_BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(this.config.HARNESS_PORT)], {
      cwd: this.config.workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const forward = (stream: NodeJS.ReadableStream | null, level: 'info' | 'warn') =>
      stream?.on('data', (buf: Buffer) => {
        for (const line of buf.toString('utf8').split('\n').filter(Boolean)) logger[level]({ harness: true }, line.slice(0, 500));
      });
    forward(child.stdout, 'info');
    forward(child.stderr, 'warn');
    child.on('error', (err) => logger.error({ err }, 'failed to spawn harness'));
    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.setState('down');
      if (this.stopping) return;
      this.restarts += 1;
      metrics.harnessRestarts.add(1);
      logger.error({ code, signal, restartInMs: this.backoffMs }, 'harness exited unexpectedly');
      setTimeout(() => {
        if (!this.stopping) this.spawnChild();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  private setState(s: HarnessState) {
    if (s === this.state) return;
    this.state = s;
    if (s === 'down' && !this.downSince) this.downSince = new Date();
    if (s === 'up') {
      this.downSince = undefined;
      this.backoffMs = 1000;
    }
    for (const l of this.listeners) l(s);
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/global/health`, {
        headers: { authorization: this.authHeader },
        signal: AbortSignal.timeout(3000),
      });
      const body = (await res.json()) as { healthy?: boolean; version?: string };
      if (res.ok && body.healthy) {
        this.version = body.version;
        this.setState('up');
        return true;
      }
    } catch {
      /* not reachable */
    }
    if (this.state === 'up') this.setState('down');
    return false;
  }

  /** Waits until the harness reports healthy (boot step 5, and before every step). */
  async waitUntilHealthy(timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.checkHealth()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** Degraded if the harness has been down for more than 60 s (spec §5.4). */
  get degraded(): boolean {
    return this.state !== 'up' && !!this.downSince && Date.now() - this.downSince.getTime() > 60_000;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
