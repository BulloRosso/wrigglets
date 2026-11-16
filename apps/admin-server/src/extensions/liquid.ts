import type { ExtensionManifestInput } from '@cw/extensions';
import type { BootstrapHandler, OverlayOptions } from './service.js';

/*
 * Liquid Enterprise (ADR-0038, docs/liquid-enterprise.md) as an extension manifest. It grows with each milestone of
 * docs/liquid-enterprise-extension.md: M0b the ontology database; M1 object storage + Iceberg catalog; M2 the compiler
 * service; M3 the ontology server (+ upstream "onto"); M4 OPA; M5 the business worker.
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
  secrets: [{ name: 'ontology_db_password', bytes: 24 }],
  services: [
    {
      name: 'ontology-db',
      description: 'Postgres for the event log (append-only) and the projection of the ontology server',
      // Same image as litellm-db in docker-compose.yml; digest pinning for all liquid images follows in M1 (ADR-0040).
      image: 'postgres:17.6-alpine',
      port: 5432,
      env: { POSTGRES_USER: 'onto', POSTGRES_PASSWORD: '{{secret:ontology_db_password}}', POSTGRES_DB: 'onto' },
      volumes: [{ name: 'ontology-db-data', target: '/var/lib/postgresql/data' }],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U onto -d onto'], intervalSec: 5, timeoutSec: 3, retries: 30, startPeriodSec: 5 },
      memoryMb: 512,
    },
  ],
  bootstrap: [],
  uiRoutes: [{ label: 'Overview', path: '/liquid' }],
};

export const liquidBootstrap: Record<string, BootstrapHandler> = {};

/** Overlay mode (docker-compose.liquid.yml): the services run from compose, secrets come from the environment. */
export function liquidOverlay(env: { LIQUID_OVERLAY?: boolean; LIQUID_ONTOLOGY_DB_PASSWORD?: string }): OverlayOptions {
  return { active: !!env.LIQUID_OVERLAY, secrets: { ontology_db_password: env.LIQUID_ONTOLOGY_DB_PASSWORD } };
}
