import { z } from 'zod';
import { AGENT_ID_PATTERN, agentTaskQueue, parseDuration } from '@cw/shared';

/*
 * All configuration comes from environment variables (spec §4). The process fails fast on
 * invalid configuration. On Azure, secrets are App Service Key Vault references.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');
const duration = z.string().refine((v) => {
  try {
    parseDuration(v);
    return true;
  } catch {
    return false;
  }
}, 'invalid duration (e.g. 4h, 7d)');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    PORT: z.coerce.number().int().optional(),
    WEBSITES_PORT: z.coerce.number().int().optional(),
    PUBLIC_BASE_URL: z.string().url().optional(),
    LOG_LEVEL: z.string().default('info'),

    AGENT_ID: z.string().regex(AGENT_ID_PATTERN),
    AGENT_DISPLAY_NAME: z.string().min(1),
    AGENT_GIT_EMAIL: z.string().email(),

    HOME_ROOT: z.string().default('/home'),
    WORKSPACE_DIR: z.string().optional(),
    ARTIFACTS_DIR: z.string().optional(),
    STAGING_DIR: z.string().optional(),
    HARNESS_DATA_DIR: z.string().optional(),

    HARNESS_ENABLED: z.string().default('true').transform((v) => v !== 'false'),
    HARNESS_BIN: z.string().default('opencode'),
    HARNESS_PORT: z.coerce.number().int().default(4096),
    HARNESS_HOME: z.string().default('/tmp/harness-home'),
    HARNESS_CONFIG_PATH: z.string().default('/tmp/harness/opencode.json'),
    HARNESS_VERSION: z.string().optional(),

    TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().default('agent-dev'),
    TEMPORAL_TASK_QUEUE: z.string().optional(),
    TEMPORAL_TLS_CERT: z.string().optional(),
    TEMPORAL_TLS_KEY: z.string().optional(),
    TEMPORAL_TLS_CA: z.string().optional(),
    TEMPORAL_TLS_SERVER_NAME: z.string().optional(),
    PAYLOAD_CODEC_KEYS: z.string().min(10),
    CODEC_CORS_ORIGINS: z.string().default(''),
    WORKFLOW_BUNDLE_PATH: z.string().optional(),

    AI_GATEWAY_BASE_URL: z.string().url(),
    AI_GATEWAY_API_KEY: z.string().min(1),
    AI_GATEWAY_MODEL: z.string().min(3),
    AI_GATEWAY_SMALL_MODEL: z.string().optional(),

    TASK_MAX_FIX_ROUNDS: z.coerce.number().int().min(0).max(10).default(2),
    TASK_MAX_REVISIONS: z.coerce.number().int().min(0).max(10).default(3),
    APPROVAL_REMINDER_AFTER: duration.default('4h'),
    APPROVAL_EXPIRE_AFTER: duration.default('7d'),
    APPROVER_POLICY: z.enum(['approver-or-requester', 'approver-only', 'requester-only']).default('approver-or-requester'),
    TASK_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),
    NOTIFY_TEAMS_WEBHOOK_URL: z.string().url().optional(),
    TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
    SYSTEM_SCHEDULES_ENABLED: z.string().default('true').transform((v) => v !== 'false'),

    BACKUP_TARGET: z.enum(['local', 'azure-blob', 'none']).default('local'),
    BACKUP_DIR: z.string().optional(),
    BACKUP_CONTAINER_URL: z.string().url().optional(),
    BACKUP_KEEP_DAYS: z.coerce.number().int().positive().default(35),

    AUTH_MODE: z.enum(['oidc', 'easyauth', 'dev']).default('oidc'),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_INTERNAL_URL: z.string().url().optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    OIDC_SCOPES: z.string().default('openid profile email'),
    SESSION_SECRET: z.string().min(32).optional(),
    SESSION_TTL: duration.default('8h'),
    ROLE_USER: z.string().default('Agent.User'),
    ROLE_APPROVER: z.string().default('Agent.Approver'),
    ROLE_ADMIN: z.string().default('Agent.Admin'),
    DEV_FAKE_USER: z.string().optional(),
    DEV_FAKE_ROLES: z.string().default('Agent.User,Agent.Approver'),

    APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),

    /* MCP gateway, A2A, control plane (ADR-0021/0023/0025) */
    AGENT_DESCRIPTION: z.string().optional(),
    MCP_GATEWAY_URL: z.string().url().optional(),
    MCP_GATEWAY_BASE_URL: z.string().url().optional(),
    MCP_GATEWAY_TOKEN: z.string().optional(),
    /** Token the MCP gateway presents when it forwards A2A calls to this agent. */
    A2A_GATEWAY_TOKEN: z.string().optional(),
    CONTROL_PLANE_URL: z.string().url().optional(),
    CONTROL_PLANE_TOKEN: z.string().optional(),
    WEB_DIST_DIR: z.string().optional(),
    TRUST_PROXY: bool,

    /* Microsoft Entra ID On-Behalf-Of towards MCP servers (optional; ADR-0032). Handed over by the control plane. */
    ENTRA_ENABLED: bool,
    ENTRA_AUTHORITY_HOST: z.string().url().default('https://login.microsoftonline.com'),
    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_CREDENTIAL_KIND: z.enum(['secret', 'cert', 'federated']).optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    ENTRA_CLIENT_CERT_PEM: z.string().optional(),
    /** Federated credential: file holding the workload identity assertion (re-read on every exchange). */
    ENTRA_FEDERATED_TOKEN_FILE: z.string().optional(),
    ENTRA_ALLOW_AGENT_ONLY: bool,
  })
  .superRefine((c, ctx) => {
    if (c.AUTH_MODE === 'oidc') {
      for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'SESSION_SECRET', 'PUBLIC_BASE_URL'] as const) {
        if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when AUTH_MODE=oidc` });
      }
    }
    if (c.AUTH_MODE === 'dev' && c.NODE_ENV !== 'development') {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'AUTH_MODE=dev is only allowed with NODE_ENV=development' });
    }
    if (c.ENTRA_ENABLED) {
      for (const k of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CREDENTIAL_KIND'] as const) {
        if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when ENTRA_ENABLED=true` });
      }
      const need = { secret: 'ENTRA_CLIENT_SECRET', cert: 'ENTRA_CLIENT_CERT_PEM', federated: 'ENTRA_FEDERATED_TOKEN_FILE' } as const;
      const k = c.ENTRA_CREDENTIAL_KIND ? need[c.ENTRA_CREDENTIAL_KIND] : undefined;
      if (k && !c[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required for credential kind ${c.ENTRA_CREDENTIAL_KIND}` });
    }
    if (c.BACKUP_TARGET === 'azure-blob' && !c.BACKUP_CONTAINER_URL) {
      ctx.addIssue({ code: 'custom', path: ['BACKUP_CONTAINER_URL'], message: 'required for BACKUP_TARGET=azure-blob' });
    }
  });

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const home = c.HOME_ROOT.replace(/\/$/, '');
  const port = c.WEBSITES_PORT ?? c.PORT ?? 8080;
  return {
    ...c,
    port,
    publicBaseUrl: (c.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    workspaceDir: c.WORKSPACE_DIR ?? `${home}/workspace`,
    artifactsDir: c.ARTIFACTS_DIR ?? `${home}/artifacts`,
    stagingDir: c.STAGING_DIR ?? `${home}/staging`,
    harnessDataDir: c.HARNESS_DATA_DIR ?? `${home}/.oc`,
    backupDir: c.BACKUP_DIR ?? `${home}/backups`,
    /** Encrypted per-user Entra tokens (refresh tokens never go into cookies or Temporal). */
    oboDir: `${home}/.obo`,
    taskQueue: c.TEMPORAL_TASK_QUEUE ?? agentTaskQueue(c.AGENT_ID),
    codecCorsOrigins: c.CODEC_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    roles: { user: c.ROLE_USER, approver: c.ROLE_APPROVER, admin: c.ROLE_ADMIN },
    devFakeRoles: c.DEV_FAKE_ROLES.split(',').map((s) => s.trim()).filter(Boolean),
    sessionTtlMs: parseDuration(c.SESSION_TTL),
    version: process.env.APP_VERSION ?? '0.1.0',
  };
}
