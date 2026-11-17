import type { ExtensionManifestInput } from '@cw/extensions';
import type { BootstrapContext, BootstrapHandler } from './service.js';

/*
 * Liquid Enterprise (ADR-0038, docs/liquid-enterprise.md) as an extension manifest, installed from the console (the only
 * deployment path since ADR-0053). Three services: the ontology database, the enterprise core (event log, lake, actions,
 * embedded policy, business worker; ADR-0049) and the Git host of the config repository. The ontology compiler and the
 * policy checks run inside the control plane (ADR-0053).
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
    // the enterprise core fetches the policy package (Rego compiled to WASM) with it (ADR-0049)
    { name: 'policy_token', bytes: 32 },
    { name: 'config_mcp_token', bytes: 32 },
    { name: 'playbook_token', bytes: 32 },
    { name: 'alerts_token', bytes: 32 },
    // the Git host of the config repository (ADR-0049); its data is SQLite in its own volume (ADR-0053)
    { name: 'forgejo_secret_key', bytes: 32 },
    { name: 'forgejo_internal_token', bytes: 48 },
    { name: 'forgejo_bot_password', bytes: 24 },
    { name: 'forgejo_reviewer_password', bytes: 18 },
    { name: 'forgejo_webhook_secret', bytes: 32 },
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
      description: 'Enterprise core: event log and lake (DuckLake), the ontology at runtime with the action pipeline (the only write path), embedded object policy, business worker (Temporal namespace business)',
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
        // object-level policy embedded (Rego → WASM from the control plane, ADR-0049)
        POLICY_MODE: 'wasm',
        POLICY_URL: 'http://temporal:8080/internal/liquid/policy',
        POLICY_TOKEN: '{{secret:policy_token}}',
        LAKE_DATA_PATH: '/lake/',
        // business worker in the same process (ADR-0049), incl. the lake-flush schedule (ADR-0045)
        TEMPORAL_ADDRESS: 'temporal:7233',
        CONTROL_PLANE_URL: 'http://temporal:8080',
        PLAYBOOK_TOKEN: '{{secret:playbook_token}}',
      },
      volumes: [{ name: 'lake-data', target: '/lake' }],
      healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:7710/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], intervalSec: 5, timeoutSec: 4, retries: 30, startPeriodSec: 10 },
      memoryMb: 1024,
    },
    {
      name: 'forgejo',
      description: 'Git host of the config repository: pull requests, CODEOWNERS, branch protection, required check liquid/validate (local; GitHub or Azure DevOps in an enterprise)',
      image: 'codeberg.org/forgejo/forgejo:15@sha256:5d050e6d623e540923ff54b1c0c7acf41c3f9174a6c7ad515cc0c63d703fcd22',
      port: 3000,
      hostPort: 3300,
      env: {
        FORGEJO__database__DB_TYPE: 'sqlite3',
        FORGEJO__database__PATH: '/data/gitea/forgejo.db',
        FORGEJO__server__ROOT_URL: '{{svc:forgejo.public}}/',
        FORGEJO__server__HTTP_PORT: '3000',
        FORGEJO__server__DISABLE_SSH: 'true',
        FORGEJO__server__OFFLINE_MODE: 'true',
        FORGEJO__security__INSTALL_LOCK: 'true',
        FORGEJO__security__SECRET_KEY: '{{secret:forgejo_secret_key}}',
        FORGEJO__security__INTERNAL_TOKEN: '{{secret:forgejo_internal_token}}',
        FORGEJO__service__DISABLE_REGISTRATION: 'true',
        FORGEJO__service__REQUIRE_SIGNIN_VIEW: 'true',
        FORGEJO__webhook__ALLOWED_HOST_LIST: 'private,loopback',
        FORGEJO__repository__DEFAULT_BRANCH: 'main',
        FORGEJO__actions__ENABLED: 'false',
        FORGEJO__mailer__ENABLED: 'false',
        FORGEJO__log__LEVEL: 'Warn',
      },
      volumes: [{ name: 'forgejo-data', target: '/data' }],
      healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/api/healthz'], intervalSec: 5, timeoutSec: 4, retries: 60, startPeriodSec: 10 },
      memoryMb: 512,
    },
  ],
  bootstrap: [
    // before the worker starts: namespace + search attributes (the handler is injected by main.ts, it needs Temporal)
    { id: 'business-namespace', description: 'Temporal namespace business with search attributes OntologyObjects, BusinessState' },
    { id: 'seed-sofa', description: 'Seed the sofa company (T0 extract into the raw zone)', demoOnly: true },
    // the desired state in Git (ADR-0046): first commit = the running platform (handler injected by main.ts)
    { id: 'config-repo', description: 'Config repository: bootstrap from the running platform (gateway, safety, agents, policies, ontology)' },
    // the Git host (ADR-0049): accounts, repository, branch protection with the required check, webhook, CODEOWNERS
    { id: 'forgejo-setup', description: 'Git host: bot and reviewer accounts, repository liquid/config, branch protection, webhook, CODEOWNERS' },
  ],
  // New ontology tools for agents; the parity groups erp/crm are re-pointed by scripts/liquid/setup.mjs (not owned).
  upstreams: [{ name: 'onto', description: 'Ontology actions of the sofa company (Liquid Enterprise): the only write path for business data', service: 'ontology-server', path: '/onto/mcp', tokenSecret: 'ontology_mcp_token', policy: 'opa' },
    { name: 'config', description: 'Platform configuration (Liquid Enterprise): read the desired state, propose changes for review', url: 'http://temporal:8080/internal/liquid/config/mcp', tokenSecret: 'config_mcp_token', policy: 'none' },
  ],
  uiRoutes: [
    { label: 'Overview', path: '/liquid' },
    { label: 'Tutorial', path: '/liquid/tutorial' },
    { label: 'Approvals', path: '/liquid/approvals' },
    { label: 'Ontology', path: '/liquid/ontology' },
    { label: 'Policies', path: '/liquid/policies' },
    { label: 'Business processes', path: '/liquid/processes' },
    { label: 'Proposals', path: '/liquid/proposals' },
    { label: 'Playbooks', path: '/liquid/playbooks' },
    { label: 'Event log', path: '/liquid/events' },
    { label: 'Apps', path: '/liquid/apps' },
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
