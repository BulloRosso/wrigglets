import { GATEWAY_ENTRY, type Decision, type PolicyEngine } from '@cw/policy-wasm';
import type { KillLevel, UpstreamServer } from '@cw/shared';

/*
 * Policy as code at the gateway (Liquid Enterprise, ADR-0044, embedded since ADR-0049). For tools of upstreams with
 * `policy: 'opa'` (Rego policies), after the gateway's own checks (allow-list, kill switch, limits, plan step) the
 * policy decides in-process: the control plane's policy package (Rego compiled to WebAssembly + data) is evaluated
 * here, no network call per decision. Fail closed: no package loaded or no decision deny.
 */

export type OpaDecision = Decision;

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

/** Decides with the embedded engine; without Liquid's policy package the upstream is refused (fail closed). */
export function decide(engine: PolicyEngine | undefined, enabled: boolean, input: GatewayOpaInput): OpaDecision {
  if (!enabled || !engine) return { allow: false, reason: 'upstream requires a policy but no policy package is configured (fail closed)', obligations: [] };
  return engine.decide(GATEWAY_ENTRY, input);
}

/**
 * The gateway enforces denials. Obligations (four eyes, step-up) need the object and an approval path, so they are
 * recorded in the audit here and enforced by the object-level policy of the enterprise core, which evaluates the same
 * overlays (ADR-0044: upstreams with policy `opa` are ontology-backed).
 */
export function gatewayVerdict(d: OpaDecision): { allowed: boolean; reason: string; obligations: string[] } {
  return { allowed: d.allow, reason: d.reason, obligations: d.allow ? d.obligations : [] };
}
