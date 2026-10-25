import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(7400),
  LOG_LEVEL: z.string().default('info'),
  DATA_DIR: z.string().default('/data'),
  /** Shared secret between control plane, gateway and agents' A2A endpoints. */
  GATEWAY_TOKEN: z.string().min(24),
  CONTROL_PLANE_URL: z.string().url().default('http://temporal:8080'),
  SYNC_INTERVAL_MS: z.coerce.number().int().min(500).default(2000),
  /** Older configuration is not trusted: tools are disabled (fail-closed). */
  MAX_STALENESS_MS: z.coerce.number().int().min(1000).default(30_000),
  KEYVAULT_URL: z.string().url().optional(),
  KEYVAULT_EMULATOR: z.string().default('false'),
});

export type GatewayEnv = z.infer<typeof schema>;

export function loadConfig(env = process.env): GatewayEnv {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error(`Invalid configuration:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return r.data;
}
