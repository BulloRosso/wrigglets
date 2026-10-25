import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

export class PathSafetyError extends Error {
  readonly status = 400;
}

/**
 * Resolves a user supplied, workspace-relative path (spec §8.4):
 * rejects absolute paths, `..` after normalization, NUL bytes, `.git/**` and symlinks that
 * escape the workspace. Returns the absolute path inside `root`.
 */
export async function resolveWorkspacePath(root: string, relPath: string | undefined, opts: { mustExist?: boolean } = {}): Promise<{ abs: string; rel: string }> {
  const raw = (relPath ?? '').replace(/\\/g, '/');
  if (raw.includes('\0')) throw new PathSafetyError('Invalid path');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new PathSafetyError('Absolute paths are not allowed');
  const normalized = path.posix.normalize(raw === '' ? '.' : raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new PathSafetyError('Path escapes the workspace');
  }
  const rel = normalized === '.' ? '' : normalized.replace(/\/$/, '');
  if (rel === '.git' || rel.startsWith('.git/')) throw new PathSafetyError('Access to .git is not allowed');

  const rootReal = await realpath(root);
  const abs = path.resolve(rootReal, rel);
  try {
    await lstat(abs);
  } catch {
    if (opts.mustExist !== false) throw Object.assign(new PathSafetyError('Not found'), { status: 404 });
    // Non-existing target: validate its parent instead.
    const parentReal = await realpath(path.dirname(abs)).catch(() => undefined);
    if (parentReal && !isInside(rootReal, parentReal)) throw new PathSafetyError('Path escapes the workspace');
    return { abs, rel };
  }
  const real = await realpath(abs);
  if (!isInside(rootReal, real)) throw new PathSafetyError('Path escapes the workspace');
  const relReal = path.relative(rootReal, real).replace(/\\/g, '/');
  if (relReal === '.git' || relReal.startsWith('.git/')) throw new PathSafetyError('Access to .git is not allowed');
  return { abs: real, rel };
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Paths that must never be changed by tasks or uploads (protected platform files). */
export const PROTECTED_PATHS = [/^\.git(\/|$)/, /^AGENTS\.md$/, /^opencode\.jsonc?$/, /^\.opencode(\/|$)/, /^\.agent\/audit(\/|$)/];

export const isProtectedPath = (rel: string) => PROTECTED_PATHS.some((re) => re.test(rel));

/**
 * File name of an upload: browsers send UTF-8, but the multipart parser decodes names as Latin-1 ("GlÃ¤nzender").
 * Recode such names, normalize to NFC and keep letters, marks and digits of all scripts; everything else that could
 * be unsafe in a path (separators, control and shell characters) becomes "_".
 */
export function uploadFileName(original: string): string {
  let name = original;
  if (/^[\x00-\xff]*$/.test(name) && /[\x80-\xff]/.test(name)) {
    const recoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!recoded.includes('�')) name = recoded;
  }
  name = (name.replace(/\\/g, '/').split('/').pop() ?? '').normalize('NFC');
  name = name.replace(/[^\p{L}\p{M}\p{N}\p{Pd}._ ()[\],+&'!#@]/gu, '_').replace(/^\.+/, '_').trim().slice(0, 180);
  return name || 'file';
}
