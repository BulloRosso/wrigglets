/** A person (or the system) as seen by the agent. Always derived server-side. */
export interface Identity {
  /** Lower-case user principal name / e-mail. */
  upn: string;
  name: string;
  /** Stable object id of the account in the identity provider. */
  oid: string;
}

/** Identity plus the roles the caller holds for the current agent. */
export interface Principal extends Identity {
  roles: string[];
}

export const AGENT_ROLES = {
  user: 'Agent.User',
  approver: 'Agent.Approver',
  admin: 'Agent.Admin',
} as const;

export const PLATFORM_ROLES = {
  admin: 'Platform.Admin',
} as const;

export const ALL_AGENT_ROLES = [AGENT_ROLES.user, AGENT_ROLES.approver, AGENT_ROLES.admin];

export const SYSTEM_IDENTITY: Identity = { upn: 'system', name: 'System', oid: 'system' };

export function toIdentity(p: Identity): Identity {
  return { upn: p.upn, name: p.name, oid: p.oid };
}
