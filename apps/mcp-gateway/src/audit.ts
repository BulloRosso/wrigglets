import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GatewayAgentStats, ToolCallAuditEntry } from '@cw/shared';

/** Audit trail of every tool call (JSONL) plus in-memory counters for the safety rules. */
export class Audit {
  private readonly file: string;
  private readonly recent: ToolCallAuditEntry[] = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'audit', 'tool-calls.jsonl');
  }

  async write(e: ToolCallAuditEntry) {
    this.recent.push(e);
    const cutoff = Date.now() - 3_600_000;
    while (this.recent.length && Date.parse(this.recent[0]!.at) < cutoff) this.recent.shift();
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(e)}\n`);
  }

  stats(agentId: string): GatewayAgentStats {
    const now = Date.now();
    const mine = this.recent.filter((e) => e.agentId === agentId);
    return {
      callsLastMinute: mine.filter((e) => now - Date.parse(e.at) < 60_000).length,
      callsLastHour: mine.length,
      deniedOrFailedLast10Min: mine.filter((e) => e.outcome !== 'ok' && now - Date.parse(e.at) < 600_000).length,
    };
  }

  /** Calls in the last minute (rate limiting). */
  callsLastMinute(agentId: string) {
    const now = Date.now();
    return this.recent.filter((e) => e.agentId === agentId && now - Date.parse(e.at) < 60_000).length;
  }

  async tail(agentId: string | undefined, limit = 100): Promise<ToolCallAuditEntry[]> {
    const text = await readFile(this.file, 'utf8').catch(() => '');
    const lines = text.split('\n').filter(Boolean);
    const out: ToolCallAuditEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const e = JSON.parse(lines[i]!) as ToolCallAuditEntry;
      if (!agentId || e.agentId === agentId || e.peer === agentId) out.push(e);
    }
    return out;
  }
}
