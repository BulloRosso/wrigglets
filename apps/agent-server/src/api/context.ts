import type { Client } from '@temporalio/client';
import type { PayloadCodec } from '@temporalio/common';
import { WorkflowUpdateFailedError } from '@temporalio/client';
import { ApplicationFailure, WorkflowNotFoundError } from '@temporalio/common';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { HealthReport } from '@cw/shared';
import type { Config } from '../config.js';
import type { HarnessEventBus } from '../harness/events.js';
import type { NotificationStore } from '../notifications.js';
import { logger } from '../logger.js';
import type { Git } from '../workspace/git.js';
import { PathSafetyError } from '../workspace/paths.js';
import type { AppAuditLog } from './appAudit.js';

export interface ApiDeps {
  config: Config;
  temporal: Client;
  codec: PayloadCodec;
  git: Git;
  events: HarnessEventBus;
  notifications: NotificationStore;
  audit: AppAuditLog;
  health: () => Promise<HealthReport>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof ZodError) return res.status(400).json({ error: 'validation failed', issues: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof PathSafetyError) return res.status((err as PathSafetyError & { status?: number }).status ?? 400).json({ error: err.message });
  if (err instanceof WorkflowNotFoundError) return res.status(404).json({ error: 'not found' });
  if (err instanceof WorkflowUpdateFailedError) {
    const cause = err.cause;
    return res.status(409).json({ error: cause instanceof ApplicationFailure || cause instanceof Error ? cause.message : err.message });
  }
  logger.error({ err, path: req.path }, 'request failed');
  res.status(500).json({ error: 'internal error' });
};
