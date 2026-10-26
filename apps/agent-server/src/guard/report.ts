import type { SecurityWarning } from '@cw/shared';
import type { Config } from '../config.js';

/** Delivers a security warning to the control plane (admin dashboard). Throws if it was not accepted (callers retry). */
export async function postSecurityAlert(config: Pick<Config, 'CONTROL_PLANE_URL' | 'CONTROL_PLANE_TOKEN' | 'AGENT_ID'>, warning: SecurityWarning, timeoutMs = 20_000): Promise<void> {
  const { CONTROL_PLANE_URL: base, CONTROL_PLANE_TOKEN: token, AGENT_ID } = config;
  if (!base || !token) throw new Error('no control plane configured for security alerts');
  const { agentId: _agentId, ...body } = warning;
  const res = await fetch(`${base}/internal/agents/${encodeURIComponent(AGENT_ID)}/security-alerts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`control plane returned ${res.status}`);
}
