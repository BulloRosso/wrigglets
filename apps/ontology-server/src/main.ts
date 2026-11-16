import pg from 'pg';
import pino from 'pino';
import { z } from 'zod';
import { EventStore, Lake } from '@cw/lake';
import { loadIr } from '@cw/ontology-sofa';
import { createApp } from './app.js';
import { opaPolicy } from './policy.js';
import { allowAll, OntologyService } from './service.js';

/*
 * Ontology server (Liquid Enterprise). M1: owns the append-only event log in the ontology DB and flushes it into the
 * lake (DuckLake: catalog in the same Postgres, Parquet files under LAKE_DATA_PATH). The flush runs every
 * FLUSH_INTERVAL_SEC and on demand; it moves to a Temporal schedule once the business worker exists (M5).
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
    FLUSH_INTERVAL_SEC: z.coerce.number().int().min(0).default(60),
    FLUSH_GRACE_SEC: z.coerce.number().int().min(0).default(60),
    LOG_LEVEL: z.string().default('info'),
    /** Object-level policy (ADR-0044): `opa` asks OPA for every action (fail closed); `off` allows (before M4 / tests). */
    POLICY_MODE: z.enum(['off', 'opa']).default('off'),
    OPA_URL: z.string().url().optional(),
    OPA_TOKEN: z.string().optional(),
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

if (env.POLICY_MODE === 'opa' && (!env.OPA_URL || !env.OPA_TOKEN)) throw new Error('POLICY_MODE=opa needs OPA_URL and OPA_TOKEN');
const ir = loadIr();
const svc = new OntologyService(pool, ir, env.POLICY_MODE === 'opa' ? opaPolicy(ir, { url: env.OPA_URL!, token: env.OPA_TOKEN! }) : allowAll);
log.info({ policy: env.POLICY_MODE }, 'object-level policy');
await svc.init();
log.info({ ontology: `${svc.ir.name}@${svc.ir.version}`, hash: svc.ir.hash.slice(0, 12), kpi: svc.company.kpi().lateOrders }, 'projection loaded, action pipeline ready');

const app = createApp({ store, lake, svc, token: env.INTERNAL_TOKEN, mcpToken: env.MCP_TOKEN, ping: async () => (await pool.query('SELECT 1')).rows.length === 1, flushGraceMs: env.FLUSH_GRACE_SEC * 1000 });
const server = app.listen(env.PORT, '0.0.0.0', () => log.info({ port: env.PORT }, 'ontology server listening'));

let timer: NodeJS.Timeout | undefined;
if (env.FLUSH_INTERVAL_SEC > 0) {
  const tick = async () => {
    try {
      const r = await lake.flush(store, { graceMs: env.FLUSH_GRACE_SEC * 1000 });
      if (r.flushed || r.waiting) log.info(r, 'lake flush');
    } catch (err) {
      log.error({ err: String(err) }, 'lake flush failed');
    } finally {
      timer = setTimeout(() => void tick(), env.FLUSH_INTERVAL_SEC * 1000);
    }
  };
  timer = setTimeout(() => void tick(), 5_000);
}

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  clearTimeout(timer);
  server.close(() => {
    lake.close();
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
