import pg from 'pg';
import pino from 'pino';
import { z } from 'zod';
import { EventStore, Lake } from '@cw/lake';
import { loadIr } from '@cw/ontology-sofa';
import { createApp } from './app.js';
import { PolicyEngine, pollPolicy } from '@cw/policy-wasm';
import { wasmPolicy } from './policy.js';
import { startBusinessWorker } from './worker/worker.js';
import { allowAll, OntologyService } from './service.js';

/*
 * Enterprise core of Liquid Enterprise (ADR-0049; service name ontology-server): one process for the event log and the
 * lake (DuckLake), the ontology at runtime with the action pipeline (REST + MCP), the embedded object policy (Rego →
 * WASM from the control plane) and the business worker (Temporal namespace `business`, dispatcher, lake-flush schedule).
 * The lake is flushed by the Temporal schedule `lake-flush` of the business worker (always on since ADR-0053).
 */

const env = z
  .object({
    PORT: z.coerce.number().int().default(7710),
    PGHOST: z.string().default('ontology-db'),
    PGPORT: z.coerce.number().int().default(5432),
    PGDATABASE: z.string().default('onto'),
    PGUSER: z.string().default('onto'),
    PGPASSWORD: z.string().min(16),
    INTERNAL_TOKEN: z.string().min(24),
    /** Bearer the MCP gateway sends (upstreams onto, erp, crm). */
    MCP_TOKEN: z.string().min(24),
    LAKE_DATA_PATH: z.string().default('/lake/'),
    FLUSH_GRACE_SEC: z.coerce.number().int().min(0).default(60),
    LOG_LEVEL: z.string().default('info'),
    /** Object-level policy: `wasm` evaluates the policy package of the control plane in-process (fail closed); `off` allows (tests). */
    POLICY_MODE: z.enum(['off', 'wasm']).default('off'),
    POLICY_URL: z.string().url().default('http://temporal:8080/internal/liquid/policy'),
    POLICY_TOKEN: z.string().optional(),
    /** Business worker in this process (ADR-0049): `on` runs the Temporal worker, the dispatcher and the lake-flush schedule. */
    TEMPORAL_ADDRESS: z.string().default('temporal:7233'),
    CONTROL_PLANE_URL: z.string().url().default('http://temporal:8080'),
    PLAYBOOK_TOKEN: z.string().default(''),
    SIM_TODAY: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-10-05'),
    MS_PER_SIM_DAY: z.coerce.number().int().min(0).default(20_000),
    RELEASE_AFTER_MS: z.coerce.number().int().min(0).default(30_000),
    // v2 gate of PurchaseOrderRelease (D3): demo pace; in production minutes and days
    DUE_DILIGENCE_POLL_MS: z.coerce.number().int().min(1000).default(5000),
    DUE_DILIGENCE_REMINDER_MS: z.coerce.number().int().min(1000).default(20_000),
    APPROVAL_REMINDER_MS: z.coerce.number().int().min(1000).default(4 * 3_600_000),
    APPROVAL_EXPIRE_MS: z.coerce.number().int().min(1000).default(7 * 86_400_000),
    DISPATCH_INTERVAL_MS: z.coerce.number().int().min(200).default(2000),
    LAKE_FLUSH_EVERY: z.string().default('1m'),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { service: 'ontology-server' }, redact: ['password', '*.password'] });

const pool = new pg.Pool({ host: env.PGHOST, port: env.PGPORT, database: env.PGDATABASE, user: env.PGUSER, password: env.PGPASSWORD, max: 8 });
const store = new EventStore(pool);

// The database may still be starting (fresh install): retry the migration for up to two minutes.
for (let attempt = 1; ; attempt++) {
  try {
    await store.migrate();
    break;
  } catch (err) {
    if (attempt >= 60) throw err;
    log.warn({ err: String(err), attempt }, 'ontology DB not ready, retrying');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const dataPath = env.LAKE_DATA_PATH.endsWith('/') ? env.LAKE_DATA_PATH : `${env.LAKE_DATA_PATH}/`;
const lake = await Lake.open({
  catalog: `postgres:dbname=${env.PGDATABASE} host=${env.PGHOST} port=${env.PGPORT} user=${env.PGUSER} password=${env.PGPASSWORD}`,
  dataPath,
  metadataSchema: 'lake_catalog',
});
log.info({ dataPath, hwm: await lake.hwm() }, 'event log and lake ready');

if (env.POLICY_MODE === 'wasm' && !env.POLICY_TOKEN) throw new Error('POLICY_MODE=wasm needs POLICY_TOKEN');
const ir = loadIr();
const engine = new PolicyEngine();
if (env.POLICY_MODE === 'wasm')
  pollPolicy({ url: env.POLICY_URL, token: () => env.POLICY_TOKEN, engine, onLoad: (rev) => log.info({ revision: rev }, 'policy package loaded'), onError: (err) => log.warn({ err }, 'policy package not updated') });
const svc = new OntologyService(pool, ir, env.POLICY_MODE === 'wasm' ? wasmPolicy(engine) : allowAll);
log.info({ policy: env.POLICY_MODE }, 'object-level policy');
await svc.init();
log.info({ ontology: `${svc.ir.name}@${svc.ir.version}`, hash: svc.ir.hash.slice(0, 12), kpi: svc.company.kpi().lateOrders }, 'projection loaded, action pipeline ready');

const app = createApp({ engine, store, lake, svc, token: env.INTERNAL_TOKEN, mcpToken: env.MCP_TOKEN, ping: async () => (await pool.query('SELECT 1')).rows.length === 1, flushGraceMs: env.FLUSH_GRACE_SEC * 1000 });
const server = app.listen(env.PORT, '0.0.0.0', () => log.info({ port: env.PORT }, 'ontology server listening'));

const business = await startBusinessWorker({
        cfg: { temporalAddress: env.TEMPORAL_ADDRESS, controlPlaneUrl: env.CONTROL_PLANE_URL, playbookToken: env.PLAYBOOK_TOKEN, today: env.SIM_TODAY, msPerSimDay: env.MS_PER_SIM_DAY, releaseAfterMs: env.RELEASE_AFTER_MS, dueDiligencePollMs: env.DUE_DILIGENCE_POLL_MS, dueDiligenceReminderMs: env.DUE_DILIGENCE_REMINDER_MS, approvalReminderMs: env.APPROVAL_REMINDER_MS, approvalExpireMs: env.APPROVAL_EXPIRE_MS, dispatchIntervalMs: env.DISPATCH_INTERVAL_MS, lakeFlushEvery: env.LAKE_FLUSH_EVERY, flushGraceMs: env.FLUSH_GRACE_SEC * 1000 },
        svc,
        store,
        lake,
        pool,
        log,
      }).catch((err) => {
        log.error({ err: String(err) }, 'business worker could not start');
        return undefined;
      });

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  void business?.stop();
  server.close(() => {
    lake.close();
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
