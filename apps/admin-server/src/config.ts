import { z } from 'zod';

const bool = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  DATA_DIR: z.string().default('/data'),
  WEB_DIST_DIR: z.string().optional(),
  TRUST_PROXY: bool('false'),

  /* Temporal */
  TEMPORAL_MODE: z.enum(['embedded', 'external']).default('embedded'),
  TEMPORAL_BIN: z.string().default('temporal'),
  TEMPORAL_ADDRESS: z.string().default('127.0.0.1:7233'),
  TEMPORAL_NAMESPACE: z.string().default('agent-dev'),
  TEMPORAL_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  TEMPORAL_UI_PUBLIC_URL: z.string().url().default('http://localhost:8233'),
  PAYLOAD_CODEC_KEYS: z.string().min(10),

  /* OAuth server administration */
  OAUTH_ISSUER: z.string().url(),
  OAUTH_INTERNAL_URL: z.string().url().optional(),
  OAUTH_ADMIN_TOKEN: z.string().min(24),
  ADMIN_CLIENT_ID: z.string().default('cw-admin'),
  ADMIN_CLIENT_SECRET: z.string().min(16),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),

  /* Agent runtime */
  RUNTIME: z.enum(['docker', 'azure-app-service']).default('docker'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  DOCKER_NETWORK: z.string().default('coworking'),
  AGENT_IMAGE: z.string().default('coworking/agent:local'),
  AGENT_IMAGE_REPOSITORY: z.string().default('coworking/agent'),
  AGENT_PORT_RANGE: z.string().regex(/^\d+-\d+$/).default('8101-8199'),
  AGENT_PUBLIC_HOST: z.string().default('localhost'),
  AGENT_BIND_IP: z.string().default('127.0.0.1'),
  /** Temporal frontend address as reachable from agent containers. */
  AGENT_TEMPORAL_ADDRESS: z.string().default('temporal:7233'),
  AGENT_OIDC_INTERNAL_URL: z.string().url().default('http://oauth:9000'),
  AGENT_LOG_LEVEL: z.string().default('info'),

  /* Defaults handed to new agents (AI gateway or the mock) */
  AI_GATEWAY_BASE_URL: z.string().url(),
  AI_GATEWAY_API_KEY: z.string().min(1),
  AI_GATEWAY_MODEL: z.string().min(1).default('mock-large'),
  APPROVAL_REMINDER_AFTER: z.string().default('4h'),

  /* MCP gateway, Key Vault, internal URLs */
  GATEWAY_TOKEN: z.string().min(24),
  MCP_GATEWAY_URL: z.string().url().default('http://mcp-gateway:7400'),
  /** Control plane URL as reachable from agent containers (portraits). */
  AGENT_CONTROL_PLANE_URL: z.string().url().default('http://temporal:8080'),
  DEMO_UPSTREAM_URL: z.string().url().optional(),
  /** Seeded into Key Vault as `mcp-demo-authorization` when missing (local demo only). */
  MCP_DEMO_TOKEN: z.string().optional(),

  /* Agent portraits (ADR-0025) */
  OPENAI_API_KEY: z.string().optional(),
  AVATAR_IMAGE_MODEL: z.string().default('gpt-image-2.5-flare'),
  AVATAR_QUALITY: z.enum(['low', 'medium', 'high']).default('medium'),
  AVATAR_DEFAULT_REFERENCE: z.string().default('/app/assets/agent-reference.png'),
  APPROVAL_EXPIRE_AFTER: z.string().default('7d'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env = process.env) {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new Error(`Invalid configuration:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const c = r.data;
  const [portFrom, portTo] = c.AGENT_PORT_RANGE.split('-').map(Number) as [number, number];
  return {
    ...c,
    publicUrl: c.PUBLIC_URL.replace(/\/$/, ''),
    oauthInternal: (c.OAUTH_INTERNAL_URL ?? c.OAUTH_ISSUER).replace(/\/$/, ''),
    portRange: { from: portFrom, to: portTo },
    sessionTtlMs: c.SESSION_TTL_HOURS * 3_600_000,
  };
}
