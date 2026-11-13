import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CorrectionRecord, ObservationRecord } from '@cw/shared';

/**
 * Signals log of this agent (ADR-0037): processed observations and human corrections, JSON lines in
 * ARTIFACTS_DIR/signals/{observations,corrections}-<yyyy-mm>.jsonl. Temporal keeps the authoritative history; this log
 * makes the observation list and the interpreter's examples cheap to read.
 */
export class SignalsStore {
  private readonly dir: string;

  constructor(artifactsDir: string) {
    this.dir = path.join(artifactsDir, 'signals');
  }

  private async append(kind: string, entry: { at: string }) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(path.join(this.dir, `${kind}-${new Date().toISOString().slice(0, 7)}.jsonl`), `${JSON.stringify(entry)}\n`);
  }

  private async read<T>(kind: string, limit: number, filter: (e: T) => boolean = () => true): Promise<T[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.jsonl')).sort().reverse();
    const out: T[] = [];
    for (const f of files) {
      const lines = (await readFile(path.join(this.dir, f), 'utf8')).split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as T;
          if (filter(e)) out.push(e);
        } catch {
          // a torn last line after a crash is skipped
        }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  appendObservation(r: ObservationRecord) {
    return this.append('observations', r);
  }

  observations(limit = 100): Promise<ObservationRecord[]> {
    return this.read<ObservationRecord>('observations', limit);
  }

  appendCorrection(c: CorrectionRecord) {
    return this.append('corrections', c);
  }

  corrections(limit: number): Promise<CorrectionRecord[]> {
    return this.read<CorrectionRecord>('corrections', limit);
  }
}
