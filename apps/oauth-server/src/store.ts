import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ALL_AGENT_ROLES, PLATFORM_ROLES, type ClientDto, type UserDto } from '@cw/shared';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface UserRecord extends UserDto {
  passwordHash: string;
}

export interface ClientRecord extends ClientDto {
  clientSecret: string;
}

interface StoreData {
  version: 1;
  users: UserRecord[];
  clients: ClientRecord[];
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * Users and OIDC clients, persisted as one JSON document (local development).
 * On Azure this store is replaced by Entra ID or a database (ADR-0004).
 */
export class Store {
  private data: StoreData = { version: 1, users: [], clients: [] };
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'store.json');
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8')) as StoreData;
    } catch {
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    // Serialize writes; write-then-rename for atomicity.
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  /* ---------------------------------------------------------------- users */

  listUsers(): UserRecord[] {
    return [...this.data.users].sort((a, b) => a.email.localeCompare(b.email));
  }

  findUser(id: string): UserRecord | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  findUserByEmail(email: string): UserRecord | undefined {
    const e = email.trim().toLowerCase();
    return this.data.users.find((u) => u.email === e);
  }

  async createUser(input: { email: string; name: string; password: string; platformRoles?: string[]; agentRoles?: Record<string, string[]> }): Promise<UserRecord> {
    const email = input.email.trim().toLowerCase();
    if (this.findUserByEmail(email)) throw Object.assign(new Error('A user with this e-mail already exists'), { status: 409 });
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      email,
      name: input.name,
      disabled: false,
      platformRoles: input.platformRoles ?? [],
      agentRoles: input.agentRoles ?? {},
      createdAt: now,
      updatedAt: now,
      passwordHash: await hashPassword(input.password),
    };
    this.data.users.push(user);
    await this.persist();
    return user;
  }

  async updateUser(id: string, patch: Partial<Pick<UserRecord, 'name' | 'disabled' | 'platformRoles' | 'agentRoles' | 'lastLoginAt'>> & { password?: string }): Promise<UserRecord> {
    const user = this.findUser(id);
    if (!user) throw Object.assign(new Error('user not found'), { status: 404 });
    if (patch.name !== undefined) user.name = patch.name;
    if (patch.disabled !== undefined) user.disabled = patch.disabled;
    if (patch.platformRoles !== undefined) user.platformRoles = patch.platformRoles;
    if (patch.agentRoles !== undefined) user.agentRoles = Object.fromEntries(Object.entries(patch.agentRoles).filter(([, r]) => r.length > 0));
    if (patch.lastLoginAt !== undefined) user.lastLoginAt = patch.lastLoginAt;
    if (patch.password) user.passwordHash = await hashPassword(patch.password);
    if (patch.lastLoginAt === undefined || Object.keys(patch).length > 1) user.updatedAt = new Date().toISOString();
    await this.persist();
    return user;
  }

  async deleteUser(id: string): Promise<void> {
    this.data.users = this.data.users.filter((u) => u.id !== id);
    await this.persist();
  }

  /** Removes all role assignments for an agent (called when the agent is deleted). */
  async removeAgentAssignments(agentId: string): Promise<void> {
    for (const u of this.data.users) delete u.agentRoles[agentId];
    await this.persist();
  }

  /* ---------------------------------------------------------------- clients */

  listClients(): ClientRecord[] {
    return [...this.data.clients];
  }

  findClient(clientId: string): ClientRecord | undefined {
    return this.data.clients.find((c) => c.clientId === clientId);
  }

  async upsertClient(c: Omit<ClientRecord, 'createdAt'>): Promise<ClientRecord> {
    const existing = this.findClient(c.clientId);
    const record: ClientRecord = { ...c, createdAt: existing?.createdAt ?? new Date().toISOString() };
    this.data.clients = [...this.data.clients.filter((x) => x.clientId !== c.clientId), record];
    await this.persist();
    return record;
  }

  async deleteClient(clientId: string): Promise<void> {
    this.data.clients = this.data.clients.filter((c) => c.clientId !== clientId);
    await this.persist();
  }
}

/** Roles a user holds towards a given client (ID-token `roles` claim). */
export function rolesForClient(user: UserDto, client: Pick<ClientDto, 'kind' | 'agentId'> | undefined): string[] {
  if (!client) return [];
  const platformAdmin = user.platformRoles.includes(PLATFORM_ROLES.admin);
  if (client.kind === 'admin') return [...user.platformRoles];
  if (client.kind === 'agent' && client.agentId) {
    if (platformAdmin) return [...ALL_AGENT_ROLES];
    const roles = new Set([...(user.agentRoles['*'] ?? []), ...(user.agentRoles[client.agentId] ?? [])]);
    return [...roles];
  }
  return [];
}

export const toUserDto = ({ passwordHash: _ph, ...u }: UserRecord): UserDto => u;
export const toClientDto = ({ clientSecret: _cs, ...c }: ClientRecord): ClientDto => c;
