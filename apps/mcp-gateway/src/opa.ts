import type { GatewayConfig, KillLevel, UpstreamServer } from '@cw/shared';

/*
 * Policy as code at the gateway (Liquid Enterprise, ADR-0044). For tools of upstreams with `policy: 'opa'`, after the
 * gateway's own allow-list check, OPA decides (data.liquid.gateway.decision). Fail closed: no OPA configuration, a
 * timeout, an error, an unexpected status or a missing decision all deny.
 */

export interface OpaDecision {
  allow: boolean;
  reason: string;
  obligations: string[];
}

export interface GatewayOpaInput {
  agent: { id: string };
  user: { upn?: string; oid?: string };
  tool: string;
  upstream: string;
  action: string;
  task: { id?: string; step?: string; interactive: boolean };
  killSwitch: KillLevel;
}

export function opaInput(p: { agentId: string; tool: string; upstream: UpstreamServer; ctx?: { taskId?: string; phase?: string; interactive?: boolean; requestedBy?: { upn?: string; oid?: string } }; killSwitch: KillLevel }): GatewayOpaInput {
  return {
    agent: { id: p.agentId },
    user: { upn: p.ctx?.requestedBy?.upn, oid: p.ctx?.requestedBy?.oid },
    tool: p.tool,
    upstream: p.upstream.name,
    action: p.tool.slice(p.upstream.name.length + 2),
    task: { id: p.ctx?.taskId, step: p.ctx?.phase, interactive: p.ctx?.interactive === true },
    killSwitch: p.killSwitch,
  };
}

/** Reads OPA's answer; anything that is not a well-formed decision is a denial. */
export function interpret(status: number, body: unknown): OpaDecision {
  if (status !== 200) return { allow: false, reason: `OPA answered HTTP ${status} (fail closed)`, obligations: [] };
  const r = (body as { result?: Partial<OpaDecision> } | undefined)?.result;
  if (!r || typeof r.allow !== 'boolean') return { allow: false, reason: 'OPA returned no decision — is the policy bundle loaded? (fail closed)', obligations: [] };
  return { allow: r.allow, reason: typeof r.reason === 'string' ? r.reason : r.allow ? 'allowed' : 'denied', obligations: Array.isArray(r.obligations) ? r.obligations.map(String) : [] };
}

export async function askOpa(
  opa: GatewayConfig['opa'],
  input: GatewayOpaInput,
  resolveToken: (v: NonNullable<GatewayConfig['opa']>['token']) => Promise<string>,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<OpaDecision> {
  if (!opa) return { allow: false, reason: 'upstream requires OPA but no policy engine is configured (fail closed)', obligations: [] };
  try {
    const token = await resolveToken(opa.token);
    const res = await (opts.fetchImpl ?? fetch)(`${opa.url.replace(/\/$/, '')}/v1/data/liquid/gateway/decision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    });
    return interpret(res.status, await res.json().catch(() => undefined));
  } catch (err) {
    return { allow: false, reason: `OPA not reachable: ${String(err).slice(0, 120)} (fail closed)`, obligations: [] };
  }
}

/**
 * The gateway enforces denials. Obligations (four eyes, step-up) need the object and an approval path, so they are
 * recorded in the audit here and enforced by the object-level policy of the ontology server, which evaluates the same
 * overlays (ADR-0044: upstreams with policy `opa` are ontology-backed).
 */
export function gatewayVerdict(d: OpaDecision): { allowed: boolean; reason: string; obligations: string[] } {
  return { allowed: d.allow, reason: d.reason, obligations: d.allow ? d.obligations : [] };
}
