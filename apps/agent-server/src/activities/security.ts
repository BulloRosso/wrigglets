import type { SecurityWarning } from '@cw/shared';
import { postSecurityAlert } from '../guard/report.js';
import { logger } from '../logger.js';
import type { ActivityDeps } from './deps.js';

/**
 * Called by the AgentWorkflow after it received a security warning (ADR-0033): raises the alert in the admin dashboard.
 * Failing makes Temporal retry with backoff, so the alert is not lost while the control plane is down.
 */
export function createReportSecurityAlert(deps: ActivityDeps) {
  return async function reportSecurityAlert(warning: SecurityWarning): Promise<void> {
    await postSecurityAlert(deps.config, warning);
    logger.warn({ alertId: warning.id, taskId: warning.taskId, tool: warning.tool }, 'security alert delivered to the control plane');
  };
}
