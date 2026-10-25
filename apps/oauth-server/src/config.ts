import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().default(9000),
  LOG_LEVEL: z.string().default('info'),
  /** Public issuer URL as seen by browsers (e.g. http://localhost:9000). */
  OAUTH_ISSUER: z.string().url(),
  DATA_DIR: z.string().default('/data'),
  /** Bearer token of the management API (used by the admin plane). */
  OAUTH_ADMIN_TOKEN: z.string().min(24),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default('admin@example.local'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().default('Platform Admin'),
  ADMIN_CLIENT_ID: z.string().default('cw-admin'),
  ADMIN_CLIENT_SECRET: z.string().min(16),
  ADMIN_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  SEED_DEMO_USERS: z.string().default('false').transform((v) => v === 'true'),
  DEMO_USER_PASSWORD: z.string().min(8).default('Welcome-2026!'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),
  WEB_DIST_DIR: z.string().optional(),
  TRUST_PROXY: z.string().default('false').transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new Error(`Invalid configuration:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return { ...r.data, OAUTH_ISSUER: r.data.OAUTH_ISSUER.replace(/\/$/, '') };
}
