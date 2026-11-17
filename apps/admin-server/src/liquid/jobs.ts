/*
 * The control plane's Liquid loops in one runner (ADR-0053): reconcile, playbook schedules, audit forwarding, approvals
 * and app expiry. Each job keeps its own work in a `tick()`; the runner owns the timers, the gate (installed, no
 * extension operation running) and the status the health view shows — last run, last success, last error, duration.
 * A job never runs twice at the same time; a failing run is recorded and the next run is attempted as scheduled.
 */

export interface JobSpec {
  id: string;
  label: string;
  everyMs: number;
  /** Delay before the first run (default: everyMs). */
  firstMs?: number;
  /** Additional condition besides the common gate (e.g. Temporal connected). */
  when?: () => boolean;
  run: () => Promise<unknown>;
}

export interface JobStatus {
  id: string;
  label: string;
  everyMs: number;
  runs: number;
  running: boolean;
  lastRunAt?: string;
  lastOkAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  lastMs?: number;
  skipped: number;
}

export class Jobs {
  private readonly jobs = new Map<string, { spec: JobSpec; status: JobStatus; timer?: NodeJS.Timeout }>();
  private started = false;

  constructor(
    /** Common gate: Liquid installed and no extension operation running. */
    private readonly gate: () => boolean,
    private readonly log?: { warn(o: object, msg: string): void },
  ) {}

  add(spec: JobSpec): this {
    if (this.jobs.has(spec.id)) throw new Error(`job ${spec.id} exists`);
    this.jobs.set(spec.id, { spec, status: { id: spec.id, label: spec.label, everyMs: spec.everyMs, runs: 0, running: false, skipped: 0 } });
    if (this.started) this.schedule(spec.id, spec.firstMs ?? spec.everyMs);
    return this;
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const { spec } of this.jobs.values()) this.schedule(spec.id, spec.firstMs ?? spec.everyMs);
  }

  stop() {
    this.started = false;
    for (const j of this.jobs.values()) if (j.timer) clearTimeout(j.timer);
  }

  /** Runs a job now (outside its schedule), e.g. for tests; respects the gate and never overlaps. */
  async runNow(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    if (j.status.running) return;
    if (!this.gate() || (j.spec.when && !j.spec.when())) {
      j.status.skipped++;
      return;
    }
    j.status.running = true;
    const t0 = Date.now();
    j.status.lastRunAt = new Date(t0).toISOString();
    try {
      await j.spec.run();
      j.status.lastOkAt = new Date().toISOString();
    } catch (err) {
      j.status.lastError = String((err as Error)?.message ?? err).slice(0, 500);
      j.status.lastErrorAt = new Date().toISOString();
      this.log?.warn({ job: id, err: j.status.lastError }, 'liquid job failed');
    } finally {
      j.status.runs++;
      j.status.running = false;
      j.status.lastMs = Date.now() - t0;
    }
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map((j) => ({ ...j.status }));
  }

  get(id: string): JobStatus | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j.status } : undefined;
  }

  private schedule(id: string, ms: number) {
    const j = this.jobs.get(id)!;
    j.timer = setTimeout(() => {
      void this.runNow(id).finally(() => {
        if (this.started) this.schedule(id, j.spec.everyMs);
      });
    }, ms);
    j.timer.unref?.();
  }
}
