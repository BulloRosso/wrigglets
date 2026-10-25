import { pino } from 'pino';

/**
 * Structured JSON logs. Never log prompt contents or file contents (spec §13) — only ids, sizes,
 * durations and token counts.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'agent-server', agentId: process.env.AGENT_ID },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.apiKey', '*.secret'],
});

export type Logger = typeof logger;
