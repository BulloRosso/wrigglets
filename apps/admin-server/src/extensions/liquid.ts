import type { ExtensionManifestInput } from '@cw/extensions';
import type { BootstrapContext, BootstrapHandler, OverlayOptions } from './service.js';

/*
 * Liquid Enterprise (ADR-0038, docs/liquid-enterprise.md) as an extension manifest. It grows with each milestone of
 * docs/liquid-enterprise-extension.md: M0b the ontology database; M1 the ontology server with event log and lake
 * (DuckLake, ADR-0040); M2 the compiler service; M3 actions + upstream "onto"; M4 OPA; M5 the business worker.
 *
 * Every service here is also declared in docker-compose.liquid.yml under the same name (checked by a test), so the
 * overlay and the console install produce the same network (service name = host name).
 */

export const LIQUID_ID = 'liquid';

export const liquidManifest: ExtensionManifestInput = {
  id: LIQUID_ID,
  name: 'Liquid Enterprise',
  description:
    'Business data in open formats, its meaning in a versioned ontology, rules as code: lake and event log, ontology server as the only write path, policy as code, holdable business workflows, playbooks that tighten automatically and loosen only with approval.',
  version: '0.1.0',
  docs: 'docs/liquid-enterprise.md',
  secrets: [
    { name: 'ontology_db_password', bytes: 24 },
    { name: 'ontology_internal_token', bytes: 32 },
    { name: 'ontology_mcp_token', bytes: 32 },
  ],
  services: [
    {
      name: 'ontology-db',
      description: 'Postgres for the event log (append-only) and the projection of the ontology server',
      // Same image as litellm-db in docker-compose.yml.
      image: 'postgres:17.6-alpine',
      port: 5432,
      env: { POSTGRES_USER: 'onto', POSTGRES_PASSWORD: '{{secret:ontology_db_password}}', POSTGRES_DB: 'onto' },
      volumes: [{ name: 'ontology-db-data', target: '/var/lib/postgresql/data' }],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U onto -d onto'], intervalSec: 5, timeoutSec: 3, retries: 30, startPeriodSec: 5 },
      memoryMb: 512,
    },
    {
      name: 'ontology-server',
      description: 'Event log owner and lake writer (DuckLake: Parquet files, catalog in ontology-db); the only write path from M3 on',
      image: 'coworking/ontology-server:local',
      local: true,
      port: 7710,
      dependsOn: ['ontology-db'],
      env: {
        PGHOST: '{{svc:ontology-db.host}}',
        PGPORT: '{{svc:ontology-db.port}}',
        PGDATABASE: 'onto',
        PGUSER: 'onto',
        PGPASSWORD: '{{secret:ontology_db_password}}',
        INTERNAL_TOKEN: '{{secret:ontology_internal_token}}',
        MCP_TOKEN: '{{secret:ontology_mcp_token}}',
        LAKE_DATA_PATH: '/lake/',
      },
      volumes: [{ name: 'lake-data', target: '/lake' }],
      healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:7710/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], intervalSec: 5, timeoutSec: 4, retries: 30, startPeriodSec: 10 },
      memoryMb: 1024,
    },
  ],
  bootstrap: [{ id: 'seed-sofa', description: 'Seed the sofa company (T0 extract into the raw zone)', demoOnly: true }],
  // New ontology tools for agents; the parity groups erp/crm are re-pointed by scripts/liquid/setup.mjs (not owned).
  upstreams: [{ name: 'onto', description: 'Ontology actions of the sofa company (Liquid Enterprise): the only write path for business data', service: 'ontology-server', path: '/onto/mcp', tokenSecret: 'ontology_mcp_token' }],
  uiRoutes: [
    { label: 'Overview', path: '/liquid' },
    { label: 'Ontology', path: '/liquid/ontology' },
  ],
};

/** Calls an internal endpoint of the ontology server with the extension's token. */
export async function ontologyCall<T>(ctx: Pick<BootstrapContext, 'url' | 'secret'>, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ctx.url('ontology-server')}${path}`, {
    method,
    headers: { authorization: `Bearer ${ctx.secret('ontology_internal_token')}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`ontology server ${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

export const liquidBootstrap: Record<string, BootstrapHandler> = {
  'seed-sofa': async (ctx) => {
    const r = await ontologyCall<{ written: boolean; counts: Record<string, number> }>(ctx, 'POST', '/internal/lake/seed', { source: 'sofa' });
    ctx.log(r.written ? 'sofa company seeded into the raw zone' : 'sofa company extract already present', { counts: r.counts });
  },
};

/** Overlay mode (docker-compose.liquid.yml): the services run from compose, secrets come from the environment. */
export function liquidOverlay(env: { LIQUID_OVERLAY?: boolean; LIQUID_ONTOLOGY_DB_PASSWORD?: string; LIQUID_ONTOLOGY_INTERNAL_TOKEN?: string; LIQUID_ONTOLOGY_MCP_TOKEN?: string }): OverlayOptions {
  return { active: !!env.LIQUID_OVERLAY, secrets: { ontology_db_password: env.LIQUID_ONTOLOGY_DB_PASSWORD, ontology_internal_token: env.LIQUID_ONTOLOGY_INTERNAL_TOKEN, ontology_mcp_token: env.LIQUID_ONTOLOGY_MCP_TOKEN } };
}
