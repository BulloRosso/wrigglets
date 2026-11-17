import { describe, expect, it } from 'vitest';
import { Jobs } from './jobs.js';

describe('Liquid job runner (ADR-0053)', () => {
  it('records runs, successes and errors; a failing run does not stop the next', async () => {
    let fail = true;
    const jobs = new Jobs(() => true).add({ id: 'a', label: 'A', everyMs: 1000, run: async () => {
      if (fail) throw new Error('boom');
    } });
    await jobs.runNow('a');
    expect(jobs.get('a')).toMatchObject({ runs: 1, lastError: 'boom' });
    fail = false;
    await jobs.runNow('a');
    expect(jobs.get('a')).toMatchObject({ runs: 2, lastError: 'boom' });
    expect(jobs.get('a')!.lastOkAt).toBeTruthy();
  });

  it('the common gate and a job condition skip runs (counted, not run)', async () => {
    let open = false;
    let n = 0;
    const jobs = new Jobs(() => open).add({ id: 'a', label: 'A', everyMs: 1000, run: async () => void n++ }).add({ id: 'b', label: 'B', everyMs: 1000, when: () => false, run: async () => void n++ });
    await jobs.runNow('a');
    open = true;
    await jobs.runNow('b');
    expect(n).toBe(0);
    expect(jobs.status().map((s) => s.skipped)).toEqual([1, 1]);
    await jobs.runNow('a');
    expect(n).toBe(1);
  });

  it('never runs a job twice at the same time', async () => {
    let n = 0;
    let release!: () => void;
    const jobs = new Jobs(() => true).add({ id: 'a', label: 'A', everyMs: 1000, run: () => new Promise<void>((r) => { n++; release = r; }) });
    const first = jobs.runNow('a');
    await jobs.runNow('a');
    expect(jobs.get('a')!.running).toBe(true);
    release();
    await first;
    expect(n).toBe(1);
  });

  it('runs on its schedule once started', async () => {
    let n = 0;
    const jobs = new Jobs(() => true).add({ id: 'a', label: 'A', everyMs: 20, firstMs: 1, run: async () => void n++ });
    jobs.start();
    await new Promise((r) => setTimeout(r, 120));
    jobs.stop();
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
