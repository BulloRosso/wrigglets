import { pino } from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'admin-server' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['*.password', '*.clientSecret', '*.apiKey', 'env'],
});
