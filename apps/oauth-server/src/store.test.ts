import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UserDto } from '@cw/shared';
import { Store, hashPassword, rolesForClient, toUserDto, verifyPassword } from './store.js';

const user = (over: Partial<UserDto>): UserDto => ({
  id: 'u1',
  email: 'anna@example.com',
  name: 'Anna',
  disabled: false,
  platformRoles: [],
  agentRoles: {},
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('rolesForClient (roles claim per OIDC client)', () => {
  it('returns agent-specific roles merged with "*" roles', () => {
    const u = user({ agentRoles: { '*': ['Agent.User'], max: ['Agent.User', 'Agent.Approver'] } });
    expect(rolesForClient(u, { kind: 'agent', agentId: 'max' }).sort()).toEqual(['Agent.Approver', 'Agent.User']);
    expect(rolesForClient(u, { kind: 'agent', agentId: 'other' })).toEqual(['Agent.User']);
  });
  it('gives platform admins every agent role and their platform roles on the console', () => {
    const u = user({ platformRoles: ['Platform.Admin'] });
    expect(rolesForClient(u, { kind: 'agent', agentId: 'x' })).toEqual(['Agent.User', 'Agent.Approver', 'Agent.Admin']);
    expect(rolesForClient(u, { kind: 'admin' })).toEqual(['Platform.Admin']);
  });
  it('gives nothing without assignment', () => {
    expect(rolesForClient(user({}), { kind: 'agent', agentId: 'max' })).toEqual([]);
    expect(rolesForClient(user({ agentRoles: { max: ['Agent.User'] } }), { kind: 'admin' })).toEqual([]);
  });
});

describe('Store', () => {
  it('hashes passwords with scrypt and verifies them', async () => {
    const h = await hashPassword('correct horse');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('persists users, rejects duplicates and never exposes the hash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cw-oauth-'));
    const s = new Store(dir);
    await s.load();
    const u = await s.createUser({ email: 'Ben@Example.com', name: 'Ben', password: 'secret123', agentRoles: { max: ['Agent.User'] } });
    expect(u.email).toBe('ben@example.com');
    await expect(s.createUser({ email: 'ben@example.com', name: 'B', password: 'secret123' })).rejects.toThrow(/exists/);
    expect(JSON.stringify(toUserDto(u))).not.toContain('scrypt');
    const reloaded = new Store(dir);
    await reloaded.load();
    expect(reloaded.findUserByEmail('BEN@example.com')?.agentRoles).toEqual({ max: ['Agent.User'] });
    await reloaded.removeAgentAssignments('max');
    expect(reloaded.findUserByEmail('ben@example.com')?.agentRoles).toEqual({});
  });
});
