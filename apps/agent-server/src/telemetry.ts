import { metrics as otelMetrics } from '@opentelemetry/api';
import { logger } from './logger.js';

/*
 * OpenTelemetry metrics (spec §18.1). Locally there is no exporter configured (the API is a no-op);
 * on Azure, APPLICATIONINSIGHTS_CONNECTION_STRING enables the Azure Monitor distro.
 */

export async function initTelemetry(connectionString?: string): Promise<void> {
  if (!connectionString) return;
  try {
    const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
    useAzureMonitor({ azureMonitorExporterOptions: { connectionString } });
    logger.info('Azure Monitor OpenTelemetry enabled');
  } catch (err) {
    logger.warn({ err }, 'could not initialize Azure Monitor');
  }
}

const meter = otelMetrics.getMeter('coworking-agent');

export const metrics = {
  tasksStarted: meter.createCounter('agent.task.started'),
  tasksCompleted: meter.createCounter('agent.task.completed'),
  tasksFailed: meter.createCounter('agent.task.failed'),
  stepDuration: meter.createHistogram('agent.step.duration', { unit: 'ms' }),
  tokensUsed: meter.createCounter('agent.tokens.used'),
  lockWait: meter.createHistogram('agent.lock.wait.duration', { unit: 'ms' }),
  harnessRestarts: meter.createCounter('agent.harness.restarts'),
};
