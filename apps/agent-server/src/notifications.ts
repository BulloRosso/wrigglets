import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NotificationDto } from '@cw/shared';

/**
 * Local notification inbox (JSON lines under ARTIFACTS_DIR/notifications). The UI shows the
 * entries addressed to the signed-in user. Teams/Graph delivery is an optional add-on.
 */
export class NotificationStore {
  private readonly dir: string;

  constructor(artifactsDir: string) {
    this.dir = path.join(artifactsDir, 'notifications');
  }

  async append(n: Omit<NotificationDto, 'id' | 'at'>): Promise<NotificationDto> {
    const entry: NotificationDto = { id: randomUUID(), at: new Date().toISOString(), ...n };
    await mkdir(this.dir, { recursive: true });
    await appendFile(path.join(this.dir, `${entry.at.slice(0, 7)}.jsonl`), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async forUser(upn: string, limit = 50): Promise<NotificationDto[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    const out: NotificationDto[] = [];
    for (const f of files) {
      const lines = (await readFile(path.join(this.dir, f), 'utf8')).split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        const n = JSON.parse(line) as NotificationDto;
        if (n.to === upn) out.push(n);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
