import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker, type NativeConnection } from '@temporalio/worker';
import type { DataConverter } from '@temporalio/common';
import type { Config } from '../config.js';
import { createActivities, type ActivityDeps } from '../activities/index.js';
import { logger } from '../logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Boot step 10. Uses the workflow bundle pre-built at build time (`dist/workflow-bundle.js`,
 * spec §7.1); falls back to bundling at start-up in development.
 */
export async function createWorker(config: Config, connection: NativeConnection, dataConverter: DataConverter, deps: ActivityDeps): Promise<Worker> {
  const bundlePath = config.WORKFLOW_BUNDLE_PATH ?? path.resolve(here, '../workflow-bundle.js');
  const workflowSource = existsSync(bundlePath)
    ? { workflowBundle: { codePath: bundlePath } }
    : { workflowsPath: fileURLToPath(import.meta.resolve('@cw/workflows')) };
  logger.info({ source: 'workflowBundle' in workflowSource ? bundlePath : 'runtime bundling' }, 'creating worker');
  return Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.taskQueue,
    ...workflowSource,
    activities: createActivities(deps),
    dataConverter,
    // One workspace: steps are serialized by the lock anyway; keep a few slots for notify/verify.
    maxConcurrentActivityTaskExecutions: 4,
    maxConcurrentLocalActivityExecutions: 4,
    shutdownGraceTime: '20 seconds',
    // Deliver cancellation to running steps within seconds (heartbeats are otherwise throttled up to 60 s).
    maxHeartbeatThrottleInterval: '5 seconds',
  });
}
