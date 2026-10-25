import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface AppAuditEntry {
  at: string;
  by: string;
  action: string;
  target: string;
  details?: Record<string, unknown>;
}

/**
 * Application audit log for actions that are not Temporal workflow events (spec §9.4):
 * schedule edits, force-release, … Write-only JSON lines in ARTIFACTS_DIR/audit-log/<yyyy-mm>.jsonl.
 */
export class AppAuditLog {
  private readonly dir: string;

  constructor(artifactsDir: string) {
    this.dir = path.join(artifactsDir, 'audit-log');
  }

  async write(entry: Omit<AppAuditEntry, 'at'>): Promise<void> {
    const line: AppAuditEntry = { at: new Date().toISOString(), ...entry };
    await mkdir(this.dir, { recursive: true });
    await appendFile(path.join(this.dir, `${line.at.slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`);
  }

  async find(filter: (e: AppAuditEntry) => boolean, limit = 100): Promise<AppAuditEntry[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    const out: AppAuditEntry[] = [];
    for (const f of files) {
      const lines = (await readFile(path.join(this.dir, f), 'utf8')).split('\n').filter(Boolean).reverse();
      for (const l of lines) {
        const e = JSON.parse(l) as AppAuditEntry;
        if (filter(e)) out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
