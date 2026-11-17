import type { JWTPayload } from 'jose';

/*
 * Role mapping for identity providers whose role values differ from the platform's (ADR-0050). Microsoft Entra ID puts
 * app roles into the `roles` claim (their *value*) and, if configured, security group object ids into `groups`.
 *
 * Spec: `source=Role[,Role…]` entries separated by `;`, e.g.
 *   "Admins=Platform.Admin;2f6c…-group-id=Agent.User,Agent.Approver"
 * A source matches an app-role value or a group id. Role values without an entry pass through unchanged, so app roles
 * named like the platform roles (recommended) need no mapping. Without a spec the `roles` claim is used as it is.
 * Groups that exceed the token limit (Entra "groups overage", `_claim_names.groups`) cannot be resolved without Graph
 * and are ignored — use app roles for large tenants.
 */
export type RoleMapper = (claims: JWTPayload) => string[];

export function parseRoleMap(spec: string | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of (spec ?? '').split(';').map((x) => x.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`role map entry "${entry}" must look like source=Role[,Role]`);
    const roles = entry.slice(eq + 1).split(',').map((x) => x.trim()).filter(Boolean);
    if (!roles.length) throw new Error(`role map entry "${entry}" names no role`);
    map.set(entry.slice(0, eq).trim(), roles);
  }
  return map;
}

export function roleMapper(spec?: string): RoleMapper {
  const map = parseRoleMap(spec);
  return (claims) => {
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const out = new Set<string>();
    for (const r of strings(claims.roles)) for (const m of map.get(r) ?? [r]) out.add(m);
    for (const g of strings(claims.groups)) for (const m of map.get(g) ?? []) out.add(m);
    return [...out];
  };
}

/** Issuer of a single-tenant Entra ID application (v2.0 endpoints). */
export function entraIssuer(tenantId: string, authorityHost = 'https://login.microsoftonline.com'): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('ENTRA_TENANT_ID must be the tenant id (a GUID), not a domain name');
  return `${authorityHost.replace(/\/$/, '')}/${tenantId}/v2.0`;
}
