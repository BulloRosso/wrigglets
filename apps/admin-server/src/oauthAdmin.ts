import type { ClientDto, CreateUserBody, UpdateUserBody, UpsertClientBody, UserDto } from '@cw/shared';

export class OAuthAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Client of the OAuth server's management API (server-to-server, bearer token). */
export class OAuthAdmin {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/admin/api${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new OAuthAdminError(res.status, data.error ?? `OAuth server returned ${res.status}`);
    return data as T;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  stats() {
    return this.call<{ users: number; clients: number; activeSessions: number }>('GET', '/stats');
  }
  users() {
    return this.call<UserDto[]>('GET', '/users');
  }
  createUser(body: CreateUserBody) {
    return this.call<UserDto>('POST', '/users', body);
  }
  updateUser(id: string, body: UpdateUserBody) {
    return this.call<UserDto>('PATCH', `/users/${encodeURIComponent(id)}`, body);
  }
  setAgentRoles(userId: string, agentId: string, roles: string[]) {
    return this.call<UserDto>('PUT', `/users/${encodeURIComponent(userId)}/agent-roles/${encodeURIComponent(agentId)}`, { roles });
  }
  deleteUser(id: string) {
    return this.call<void>('DELETE', `/users/${encodeURIComponent(id)}`);
  }
  revokeSessions(id: string) {
    return this.call<{ revoked: number }>('POST', `/users/${encodeURIComponent(id)}/revoke-sessions`);
  }
  clients() {
    return this.call<ClientDto[]>('GET', '/clients');
  }
  upsertClient(c: UpsertClientBody) {
    return this.call<ClientDto>('PUT', `/clients/${encodeURIComponent(c.clientId)}`, c);
  }
  deleteClient(clientId: string, removeAssignments: boolean) {
    return this.call<void>('DELETE', `/clients/${encodeURIComponent(clientId)}?removeAssignments=${removeAssignments}`);
  }
}
