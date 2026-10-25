import type { Server } from 'node:http';
import type { Client } from '@temporalio/client';
import type { HealthReport } from '@cw/shared';
import { AppAuditLog } from './api/appAudit.js';
import { createApp } from './api/app.js';
import { createAuth } from './api/auth.js';
import { GatewayClient } from './gatewayClient.js';
import { SpendClient } from './spend.js';
import { loadConfig } from './config.js';
import { OpencodeHarnessClient } from './harness/client.js';
import { HarnessEventBus } from './harness/events.js';
import { HarnessSupervisor } from './harness/supervisor.js';
import { logger } from './logger.js';
import { NotificationStore } from './notifications.js';
import { initTelemetry } from './telemetry.js';
import { ensureAgentWorkflow, ensureSystemSchedules } from './temporal/bootstrap.js';
import { connectClient, connectWorker, createDataConverter } from './temporal/connection.js';
import { createWorker } from './temporal/worker.js';
import { prepareWorkspace } from './workspace/init.js';

/** Boot sequence (spec §5.2) and graceful shutdown (spec §5.3). */
async function main() {
  // 1. Config + telemetry
  const config = loadConfig();
  await initTelemetry(config.APPLICATIONINSIGHTS_CONNECTION_STRING);
  logger.info({ agentId: config.AGENT_ID, taskQueue: config.taskQueue, namespace: config.TEMPORAL_NAMESPACE, authMode: config.AUTH_MODE }, 'booting agent');

  // 2.+3. Persistent directories, workspace repository, git config
  const git = await prepareWorkspace(config);

  // 4.+5. Harness config + supervised harness process
  const supervisor = new HarnessSupervisor(config);
  const harness = new OpencodeHarnessClient(supervisor.baseUrl, () => supervisor.authHeader, config.workspaceDir);
  const events = new HarnessEventBus(harness, config.workspaceDir);
  if (config.HARNESS_ENABLED) {
    await supervisor.start();
    if (!(await supervisor.waitUntilHealthy(60_000))) throw new Error('Agent Harness did not become healthy within 60 s');
    logger.info({ version: supervisor.version }, 'agent harness is up');
    events.start();
  }

  // 6. Temporal client + worker connection (mTLS + payload codec)
  const dataConverter = createDataConverter(config);
  const codec = dataConverter.payloadCodecs![0]!;
  const client: Client = await connectClient(config, dataConverter);
  const workerConnection = await connectWorker(config);

  // 7.+8. Singleton lock manager + system schedules
  await ensureAgentWorkflow(client, config);
  await ensureSystemSchedules(client, config);

  // Temporal health (cached 30 s, spec §9.2)
  let temporalHealth: HealthReport['temporal'] = { state: 'up', namespace: config.TEMPORAL_NAMESPACE };
  let temporalCheckedAt = 0;
  async function health(): Promise<HealthReport> {
    if (Date.now() - temporalCheckedAt > 30_000) {
      temporalCheckedAt = Date.now();
      try {
        await client.connection.workflowService.describeNamespace({ namespace: config.TEMPORAL_NAMESPACE });
        temporalHealth = { state: 'up', namespace: config.TEMPORAL_NAMESPACE, checkedAt: new Date().toISOString() };
      } catch (err) {
        temporalHealth = { state: 'down', namespace: config.TEMPORAL_NAMESPACE, checkedAt: new Date().toISOString(), error: String(err).slice(0, 200) };
      }
    }
    const harnessDegraded = config.HARNESS_ENABLED && supervisor.degraded;
    return {
      status: temporalHealth.state === 'down' ? 'down' : harnessDegraded ? 'degraded' : 'ok',
      version: config.version,
      agentId: config.AGENT_ID,
      displayName: config.AGENT_DISPLAY_NAME,
      harness: {
        state: config.HARNESS_ENABLED ? supervisor.state : 'down',
        version: supervisor.version,
        downSince: supervisor.downSince?.toISOString(),
        restarts: supervisor.restarts,
      },
      temporal: temporalHealth,
    };
  }

  // 9. HTTP
  const notifications = new NotificationStore(config.artifactsDir);
  const spend = new SpendClient(config);
  const deps = { config, temporal: client, codec, git, events, notifications, audit: new AppAuditLog(config.artifactsDir), health, spend };
  const app = createApp(deps, createAuth(config));
  const server: Server = app.listen(config.port, () => logger.info({ port: config.port, url: config.publicBaseUrl }, 'http server listening'));
  server.keepAliveTimeout = 65_000;

  // 10. Worker
  const worker = await createWorker(config, workerConnection, dataConverter, {
    config,
    git,
    harness,
    supervisor,
    events,
    temporal: () => client,
    codec,
    notifications,
    gateway: new GatewayClient(config.MCP_GATEWAY_BASE_URL, config.AGENT_ID, config.MCP_GATEWAY_TOKEN),
    spend,
  });

  let workerDone: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close();
    server.closeAllConnections?.();
    worker.shutdown();
    const timeout = new Promise((r) => setTimeout(r, 20_000));
    await Promise.race([workerDone ?? Promise.resolve(), timeout]);
    events.stop();
    await supervisor.stop();
    await workerConnection.close().catch(() => undefined);
    await client.connection.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  workerDone = worker.run();
  logger.info('worker running');
  await workerDone;
}

main().catch((err) => {
  logger.fatal({ err }, 'agent failed to start');
  process.exit(1);
});
