import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isProtectedPath, resolveWorkspacePath } from '../src/workspace/paths.js';
import { parseEasyAuthPrincipal } from '../src/api/auth.js';
import { parseAnomalies } from '../src/activities/verify.js';

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cw-ws-'));
  outside = await mkdtemp(path.join(tmpdir(), 'cw-out-'));
  await mkdir(path.join(root, 'docs'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'docs', 'a.md'), '# a');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(outside, path.join(root, 'escape'), 'junction');
    await symlink(path.join(root, 'docs'), path.join(root, 'inside-link'), 'junction');
  } catch {
    /* symlinks may be unavailable on some Windows setups */
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('resolveWorkspacePath (spec §8.4)', () => {
  it('resolves normal paths', async () => {
    expect((await resolveWorkspacePath(root, 'docs/a.md')).rel).toBe('docs/a.md');
    expect((await resolveWorkspacePath(root, '')).rel).toBe('');
    expect((await resolveWorkspacePath(root, './docs/../docs/a.md')).rel).toBe('docs/a.md');
  });

  it.each([
    ['/etc/passwd', /Absolute/],
    ['C:/Windows', /Absolute/],
    ['../x', /escapes/],
    ['docs/../../x', /escapes/],
    ['a\0b', /Invalid/],
    ['.git/config', /\.git/],
    ['.git', /\.git/],
  ])('rejects %s', async (p, re) => {
    await expect(resolveWorkspacePath(root, p)).rejects.toThrow(re);
  });

  it('rejects symlinks that escape the workspace', async () => {
    try {
      await resolveWorkspacePath(root, 'inside-link/a.md');
    } catch {
      return; // symlinks not supported here
    }
    await expect(resolveWorkspacePath(root, 'escape/secret.txt')).rejects.toThrow(/escapes/);
  });

  it('allows non-existing targets for uploads only when requested', async () => {
    await expect(resolveWorkspacePath(root, 'new/file.csv')).rejects.toThrow(/Not found/);
    expect((await resolveWorkspacePath(root, 'new/file.csv', { mustExist: false })).rel).toBe('new/file.csv');
  });

  it('knows the protected platform files', () => {
    for (const p of ['AGENTS.md', 'opencode.json', '.opencode/x', '.agent/audit/2026/10/t.json', '.git/HEAD']) expect(isProtectedPath(p)).toBe(true);
    for (const p of ['reports/a.md', '.agent/plans/t.md', 'docs/AGENTS.md']) expect(isProtectedPath(p)).toBe(false);
  });
});

describe('EasyAuth principal (spec §9.1)', () => {
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
  it('derives identity and roles from claims', () => {
    const p = parseEasyAuthPrincipal(
      encode({
        auth_typ: 'aad',
        name_typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
        role_typ: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
        claims: [
          { typ: 'preferred_username', val: 'Anna@Example.Com' },
          { typ: 'name', val: 'Anna' },
          { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: 'oid-1' },
          { typ: 'roles', val: 'Agent.User' },
          { typ: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role', val: 'Agent.Approver' },
        ],
      }),
    );
    expect(p).toEqual({ upn: 'anna@example.com', name: 'Anna', oid: 'oid-1', roles: ['Agent.User', 'Agent.Approver'] });
  });
  it('rejects principals without upn or oid', () => {
    expect(parseEasyAuthPrincipal(encode({ claims: [{ typ: 'name', val: 'x' }] }))).toBeUndefined();
  });
});

describe('verification plug-in output', () => {
  it('parses anomalies as array, object or junk', () => {
    expect(parseAnomalies('["a", {"message": "b"}]')).toEqual(['a', 'b']);
    expect(parseAnomalies('{"anomalies": ["c"]}')).toEqual(['c']);
    expect(parseAnomalies('not json')).toEqual([]);
    expect(parseAnomalies('')).toEqual([]);
  });
});
