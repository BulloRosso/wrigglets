import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection, ScheduleAlreadyRunning, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { Duration } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import type pg from 'pg';
import { BSA, BUSINESS_NAMESPACE, BUSINESS_TASK_QUEUE } from '@cw/business-workflows';
import type { EventStore, Lake } from '@cw/lake';
import type { OntologyService } from '../service.js';
import { coreActivities, playbookActivities } from './activities.js';
import { commandsFor, type DispatchEvent, type IrActionLite } from './dispatcher.js';

/*
 * The business side of the enterprise core (ADR-0045, merged in ADR-0049): Temporal worker of namespace `business`,
 * the dispatcher (outbox: committed events start/signal workflows, cursor in the database), and the lake-flush schedule.
 */

export interface WorkerConfig {
  temporalAddress: string;
  controlPlaneUrl: string;
  playbookToken: string;
  today: string;
  msPerSimDay: number;
  releaseAfterMs: number;
  approvalReminderMs: number;
  approvalExpireMs: number;
  dispatchIntervalMs: number;
  lakeFlushEvery: string;
  flushGraceMs: number;
}

interface Log {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
}

const here = path.dirname(fileURLToPath(import.meta.url));

async function retry<T>(log: Log, what: string, fn: () => Promise<T>, attempts = 150): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log.warn({ err: String(err), attempt: i }, `${what} not ready, retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function startBusinessWorker(o: { cfg: WorkerConfig; svc: OntologyService; store: EventStore; lake: Lake; pool: pg.Pool; log: Log }) {
  const { cfg, log } = o;
  const native = await retry(log, 'Temporal', () => NativeConnection.connect({ address: cfg.temporalAddress }));
  const connection = await retry(log, 'Temporal client', () => Connection.connect({ address: cfg.temporalAddress }));
  // the namespace is created by the extension's bootstrap step after the services start: wait for it
  await retry(log, 'namespace business', () => connection.workflowService.describeNamespace({ namespace: BUSINESS_NAMESPACE }));
  const client = new Client({ connection, namespace: BUSINESS_NAMESPACE });
  const bundlePath = path.resolve(here, '../workflow-bundle.js');
  const worker = await Worker.create({
    connection: native,
    namespace: BUSINESS_NAMESPACE,
    taskQueue: BUSINESS_TASK_QUEUE,
    ...(existsSync(bundlePath) ? { workflowBundle: { codePath: bundlePath } } : { workflowsPath: (await import('node:module')).createRequire(import.meta.url).resolve('@cw/business-workflows') }),
    activities: { ...coreActivities({ svc: o.svc, store: o.store, lake: o.lake, flushGraceMs: cfg.flushGraceMs }), ...playbookActivities({ controlPlaneUrl: cfg.controlPlaneUrl, token: cfg.playbookToken }) },
    shutdownGraceTime: '10 seconds',
  });
  try {
    await client.schedule.create({
      scheduleId: 'lake-flush',
      spec: { intervals: [{ every: cfg.lakeFlushEvery as Duration }] },
      action: { type: 'startWorkflow', workflowType: 'lakeFlush', taskQueue: BUSINESS_TASK_QUEUE, workflowId: 'lake-flush' },
      policies: { overlap: 'SKIP' },
    });
  } catch (err) {
    if (!(err instanceof ScheduleAlreadyRunning)) throw err;
  }

  // dispatcher: cursor in the database (first start: the current end of the log)
  await o.pool.query('CREATE TABLE IF NOT EXISTS dispatch_cursor (id text PRIMARY KEY, seq bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  let cursor = Number((await o.pool.query<{ seq: string }>("SELECT seq FROM dispatch_cursor WHERE id = 'business'")).rows[0]?.seq ?? (await o.store.stats()).maxSeq);
  const save = () => o.pool.query("INSERT INTO dispatch_cursor (id, seq) VALUES ('business', $1) ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq, updated_at = now()", [cursor]);
  await save();
  const dcfg = { today: cfg.today, msPerSimDay: cfg.msPerSimDay, releaseAfterMs: cfg.releaseAfterMs, approvalReminderMs: cfg.approvalReminderMs, approvalExpireMs: cfg.approvalExpireMs };
  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      try {
        const actions = new Map(o.svc.ir.actions.map((a) => [a.name, a as unknown as IrActionLite]));
        const events = (await o.store.readAfter(cursor, 200)) as unknown as DispatchEvent[];
        for (const e of events) {
          for (const c of commandsFor(e, actions, dcfg)) {
            if (c.kind === 'start') {
              try {
                await client.workflow.start(c.workflowType, { taskQueue: BUSINESS_TASK_QUEUE, workflowId: c.workflowId, args: c.args, typedSearchAttributes: [{ key: BSA.OntologyObjects, value: c.objects }] });
                log.info({ seq: e.seq, workflowId: c.workflowId }, 'workflow started');
              } catch (err) {
                if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
              }
            } else {
              for await (const w of client.workflow.list({ query: c.query })) {
                await client.workflow.getHandle(w.workflowId).signal(c.signal, c.payload).catch((err: unknown) => log.warn({ err: String(err), workflowId: w.workflowId }, 'signal failed'));
              }
            }
          }
          cursor = e.seq;
          await save();
        }
        if (!events.length) await new Promise((r) => setTimeout(r, cfg.dispatchIntervalMs));
      } catch (err) {
        log.warn({ err: String(err) }, 'dispatch failed, retrying');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  log.info({ namespace: BUSINESS_NAMESPACE, cursor }, 'business worker running in the enterprise core');
  const done = Promise.all([worker.run(), loop()]);
  return {
    cursor: () => cursor,
    async stop() {
      stopping = true;
      worker.shutdown();
      await done.catch(() => undefined);
      await connection.close();
    },
  };
}
