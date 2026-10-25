import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SEARCH_ATTRIBUTE_CLI_DEFINITIONS } from '@cw/shared/search-attributes';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Runs the Temporal server inside this (the "temporal") container as a supervised child
 * process: `temporal server start-dev` with a SQLite file on the data volume, the Temporal Web UI
 * on :8233 and the codec endpoint of this admin server (ADR-0002).
 *
 * The Temporal binary is used unmodified (spec §1.2: no forks).
 */
export class TemporalDevServer {
  private child?: ChildProcess;
  private stopping = false;
  private backoff = 1000;
  state: 'starting' | 'up' | 'down' = 'starting';
  restarts = 0;

  constructor(private readonly config: Config) {}

  async start(): Promise<void> {
    const dbDir = path.join(this.config.DATA_DIR, 'temporal');
    await mkdir(dbDir, { recursive: true });
    this.spawn(path.join(dbDir, 'temporal.db'));
  }

  private spawn(dbFile: string) {
    const args = [
      'server',
      'start-dev',
      '--ip', '0.0.0.0',
      '--port', '7233',
      '--ui-port', '8233',
      '--http-port', '7243',
      '--metrics-port', '7244',
      '--db-filename', dbFile,
      '--namespace', this.config.TEMPORAL_NAMESPACE,
      '--ui-codec-endpoint', `${this.config.publicUrl}/codec`,
      '--ui-disable-news-fetch',
      '--log-level', 'warn',
      ...SEARCH_ATTRIBUTE_CLI_DEFINITIONS.flatMap(([name, type]) => ['--search-attribute', `${name}=${type}`]),
    ];
    logger.info({ bin: this.config.TEMPORAL_BIN, dbFile }, 'starting Temporal dev server');
    const child = spawn(this.config.TEMPORAL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const forward = (s: NodeJS.ReadableStream | null) =>
      s?.on('data', (b: Buffer) => {
        for (const line of b.toString('utf8').split('\n').filter(Boolean)) logger.info({ temporal: true }, line.slice(0, 1000));
      });
    forward(child.stdout);
    forward(child.stderr);
    child.on('exit', (code, signal) => {
      this.state = 'down';
      this.child = undefined;
      if (this.stopping) return;
      this.restarts += 1;
      logger.error({ code, signal, restartInMs: this.backoff }, 'Temporal dev server exited');
      setTimeout(() => this.spawn(dbFile), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  markUp() {
    this.state = 'up';
    this.backoff = 1000;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
