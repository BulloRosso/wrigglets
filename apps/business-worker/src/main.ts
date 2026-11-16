import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection, ScheduleAlreadyRunning, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { Duration } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import pino from 'pino';
import { z } from 'zod';
import { BSA, BUSINESS_NAMESPACE, BUSINESS_TASK_QUEUE } from '@cw/business-workflows';
import { createActivities } from './activities.js';
import { commandsFor, type DispatchEvent, type IrActionLite } from './dispatcher.js';

/*
 * Business worker (Liquid Enterprise, ADR-0045): runs the business workflows in namespace `business`, dispatches
 * committed events to workflows, and owns the `lake-flush` schedule (replacing the ontology server's flush loop).
 */

const env = z
  .object({
    TEMPORAL_ADDRESS: z.string().default('temporal:7233'),
    ONTOLOGY_URL: z.string().url().default('http://ontology-server:7710'),
    INTERNAL_TOKEN: z.string().min(24),
    DATA_DIR: z.string().default('/data'),
    SIM_TODAY: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-10-05'),
    MS_PER_SIM_DAY: z.coerce.number().int().min(0).default(20_000),
    RELEASE_AFTER_MS: z.coerce.number().int().min(0).default(30_000),
    APPROVAL_REMINDER_MS: z.coerce.number().int().min(1000).default(4 * 3_600_000),
    APPROVAL_EXPIRE_MS: z.coerce.number().int().min(1000).default(7 * 86_400_000),
    DISPATCH_INTERVAL_MS: z.coerce.number().int().min(200).default(2000),
    LAKE_FLUSH_EVERY: z.string().default('1m'),
    LOG_LEVEL: z.string().default('info'),
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: 'business-worker' } });
const here = path.dirname(fileURLToPath(import.meta.url));

async function connect<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 150) throw err;
      log.warn({ err: String(err), attempt: i }, `${what} not ready, retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const native = await connect('Temporal', () => NativeConnection.connect({ address: env.TEMPORAL_ADDRESS }));
const connection = await connect('Temporal client', () => Connection.connect({ address: env.TEMPORAL_ADDRESS }));
const client = new Client({ connection, namespace: BUSINESS_NAMESPACE });
const activities = createActivities({ ontologyUrl: env.ONTOLOGY_URL, token: env.INTERNAL_TOKEN });

const bundlePath = path.resolve(here, 'workflow-bundle.js');
// the namespace is created by the extension's bootstrap step after the services start: wait for it
await connect('namespace business', () => connection.workflowService.describeNamespace({ namespace: BUSINESS_NAMESPACE }));
const worker = await Worker.create({
  connection: native,
  namespace: BUSINESS_NAMESPACE,
  taskQueue: BUSINESS_TASK_QUEUE,
  ...(existsSync(bundlePath) ? { workflowBundle: { codePath: bundlePath } } : { workflowsPath: (await import('node:module')).createRequire(import.meta.url).resolve('@cw/business-workflows') }),
  activities,
  shutdownGraceTime: '10 seconds',
});

// lake flush as a Temporal schedule (idempotent creation)
try {
  await client.schedule.create({
    scheduleId: 'lake-flush',
    spec: { intervals: [{ every: env.LAKE_FLUSH_EVERY as Duration }] },
    action: { type: 'startWorkflow', workflowType: 'lakeFlush', taskQueue: BUSINESS_TASK_QUEUE, workflowId: 'lake-flush' },
    policies: { overlap: 'SKIP' },
  });
  log.info({ every: env.LAKE_FLUSH_EVERY }, 'schedule lake-flush created');
} catch (err) {
  if (!(err instanceof ScheduleAlreadyRunning)) throw err;
}

/* ------------------------------------------------------------------ dispatcher */

const cursorFile = path.join(env.DATA_DIR, 'dispatch-cursor.json');
const ontology = async (p: string) => {
  const res = await fetch(`${env.ONTOLOGY_URL}${p}`, { headers: { authorization: `Bearer ${env.INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ontology server ${res.status} for ${p}`);
  return res.json() as Promise<Record<string, unknown>>;
};
let actions = new Map<string, IrActionLite>();
const loadIr = async () => {
  const ir = (await ontology('/internal/ontology')) as { actions: IrActionLite[]; version: string };
  actions = new Map(ir.actions.map((a) => [a.name, a]));
  return ir.version;
};
// first start: begin at the current end of the log (history before the worker existed is not replayed into workflows)
let cursor: number;
try {
  cursor = Number(JSON.parse(await readFile(cursorFile, 'utf8')).seq);
} catch {
  cursor = Number(((await connect('ontology server', () => ontology('/internal/events?after=0&limit=1'))).stats as { maxSeq: number }).maxSeq);
}
const saveCursor = async () => {
  await mkdir(path.dirname(cursorFile), { recursive: true });
  await writeFile(`${cursorFile}.tmp`, JSON.stringify({ seq: cursor, at: new Date().toISOString() }));
  await rename(`${cursorFile}.tmp`, cursorFile);
};
log.info({ cursor, ontology: await connect('ontology IR', loadIr) }, 'dispatcher starting');

const cfg = { today: env.SIM_TODAY, msPerSimDay: env.MS_PER_SIM_DAY, releaseAfterMs: env.RELEASE_AFTER_MS, approvalReminderMs: env.APPROVAL_REMINDER_MS, approvalExpireMs: env.APPROVAL_EXPIRE_MS };
let stopping = false;
async function dispatchLoop() {
  while (!stopping) {
    try {
      const { events } = (await ontology(`/internal/events?after=${cursor}&limit=200`)) as { events: DispatchEvent[] };
      for (const e of events) {
        for (const c of commandsFor(e, actions, cfg)) {
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
              log.info({ seq: e.seq, workflowId: w.workflowId, signal: c.signal }, 'workflow signalled');
            }
          }
        }
        cursor = e.seq;
        await saveCursor();
      }
      if (!events.length) await new Promise((r) => setTimeout(r, env.DISPATCH_INTERVAL_MS));
    } catch (err) {
      log.warn({ err: String(err) }, 'dispatch failed, retrying');
      await new Promise((r) => setTimeout(r, 5000));
      await loadIr().catch(() => undefined);
    }
  }
}
setInterval(() => void loadIr().catch(() => undefined), 60_000).unref();

const shutdown = () => {
  stopping = true;
  worker.shutdown();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
log.info({ namespace: BUSINESS_NAMESPACE, taskQueue: BUSINESS_TASK_QUEUE }, 'business worker running');
await Promise.all([worker.run(), dispatchLoop()]);
await connection.close();
process.exit(0);
