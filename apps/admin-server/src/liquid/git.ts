import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/*
 * Git plumbing over a bare repository (config repository, ADR-0046). No working tree: commits are built in a temporary
 * index from blobs, refs are moved with compare-and-swap (update-ref <new> <old>), so concurrent writers never lose a
 * commit silently. Requires the git CLI (installed in the control-plane image).
 */

export interface Author {
  name: string;
  email: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class GitRepo {
  constructor(
    readonly dir: string,
    private readonly bin = process.env.GIT_BIN || 'git',
  ) {}

  run(args: string[], o: { input?: string | Buffer; env?: Record<string, string>; okCodes?: number[] } = {}): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, ['--git-dir', this.dir, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...o.env }, windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      p.stdout.on('data', (b: Buffer) => out.push(b));
      p.stderr.on('data', (b: Buffer) => err.push(b));
      p.on('error', reject);
      p.on('close', (code) => {
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (code === 0 || (code !== null && o.okCodes?.includes(code))) resolve({ stdout, code: code ?? 0 });
        else reject(new GitError(`git ${args[0]} failed (${code}): ${stderr.trim().slice(0, 500)}`, code, stderr));
      });
      p.stdin.on('error', () => undefined);
      p.stdin.end(o.input ?? '');
    });
  }

  async exists(): Promise<boolean> {
    return existsSync(path.join(this.dir, 'HEAD'));
  }

  async init(): Promise<void> {
    if (await this.exists()) return;
    await mkdir(this.dir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const p = spawn(this.bin, ['init', '--bare', '--initial-branch=main', this.dir], { windowsHide: true });
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`git init failed (${c})`))));
    });
  }

  /** Commit id of a ref (branch name or full ref), or null if it does not exist. */
  async rev(ref: string): Promise<string | null> {
    const { stdout, code } = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okCodes: [1, 128] });
    return code === 0 ? stdout.trim() : null;
  }

  async treeOf(commit: string): Promise<string> {
    return (await this.run(['rev-parse', `${commit}^{tree}`])).stdout.trim();
  }

  async paths(rev: string): Promise<string[]> {
    const { stdout } = await this.run(['ls-tree', '-r', '-z', '--name-only', rev]);
    return stdout.split('\0').filter(Boolean);
  }

  /** All files of a revision as { path: text }. */
  async files(rev: string, prefix?: string): Promise<Record<string, string>> {
    const all = (await this.paths(rev)).filter((p) => !prefix || p.startsWith(prefix));
    if (!all.length) return {};
    const { stdout } = await this.run(['cat-file', '--batch'], { input: all.map((p) => `${rev}:${p}`).join('\n') + '\n' });
    const buf = Buffer.from(stdout, 'utf8');
    const out: Record<string, string> = {};
    let off = 0;
    for (const p of all) {
      const nl = buf.indexOf(0x0a, off);
      const [, , size] = buf.subarray(off, nl).toString('utf8').split(' ');
      const n = Number(size);
      out[p] = buf.subarray(nl + 1, nl + 1 + n).toString('utf8');
      off = nl + 1 + n + 1;
    }
    return out;
  }

  async file(rev: string, p: string): Promise<string | null> {
    const { stdout, code } = await this.run(['cat-file', 'blob', `${rev}:${p}`], { okCodes: [128] });
    return code === 0 ? stdout : null;
  }

  /**
   * Commits changes ({ path: text | null = delete }) on top of `parent` and moves `ref` to it, only if `ref` still
   * points at `expect` (compare-and-swap; null = ref must not exist). Returns the new commit, or null if nothing changed.
   */
  async commit(o: { ref: string; parent: string | null; expect?: string | null; changes: Record<string, string | null>; message: string; author: Author; committer?: Author; extraParents?: string[]; tree?: string }): Promise<string | null> {
    let tree = o.tree;
    if (!tree) {
      const index = path.join(os.tmpdir(), `cw-git-index-${randomUUID()}`);
      const env = { GIT_INDEX_FILE: index };
      try {
        await this.run(o.parent ? ['read-tree', o.parent] : ['read-tree', '--empty'], { env });
        for (const [p, content] of Object.entries(o.changes).sort(([a], [b]) => a.localeCompare(b))) {
          if (content === null) {
            await this.run(['update-index', '--force-remove', '--', p], { env });
            continue;
          }
          const sha = (await this.run(['hash-object', '-w', '--stdin', '--path', p], { input: content })).stdout.trim();
          await this.run(['update-index', '--add', '--cacheinfo', `100644,${sha},${p}`], { env });
        }
        tree = (await this.run(['write-tree'], { env })).stdout.trim();
      } finally {
        await rm(index, { force: true });
      }
    }
    if (o.parent && !o.extraParents?.length && tree === (await this.treeOf(o.parent))) return null;
    const committer = o.committer ?? o.author;
    const env = { GIT_AUTHOR_NAME: o.author.name, GIT_AUTHOR_EMAIL: o.author.email, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email };
    const parents = [o.parent, ...(o.extraParents ?? [])].filter((x): x is string => !!x).flatMap((p) => ['-p', p]);
    const commit = (await this.run(['commit-tree', tree, ...parents], { input: o.message, env })).stdout.trim();
    const ref = o.ref.startsWith('refs/') ? o.ref : `refs/heads/${o.ref}`;
    const expect = o.expect === undefined ? o.parent : o.expect;
    await this.run(['update-ref', ref, commit, expect ?? '0000000000000000000000000000000000000000']);
    return commit;
  }

  /** Three-way merge of two commits without a working tree: { tree } or { conflicts } (git ≥ 2.38). */
  async mergeTree(ours: string, theirs: string): Promise<{ tree: string } | { conflicts: string[] }> {
    const { stdout, code } = await this.run(['merge-tree', '--write-tree', '--name-only', ours, theirs], { okCodes: [1] });
    const [tree, ...rest] = stdout.split('\n');
    if (code === 0) return { tree: tree!.trim() };
    return { conflicts: rest.filter((l) => l.trim() && !/^(Auto-merging|CONFLICT)/.test(l)).map((l) => l.trim()) };
  }

  async diff(a: string, b: string): Promise<string> {
    return (await this.run(['diff', '--no-color', '--no-ext-diff', a, b])).stdout;
  }

  async changedPaths(a: string, b: string): Promise<string[]> {
    return (await this.run(['diff', '--name-only', '-z', a, b])).stdout.split('\0').filter(Boolean);
  }

  async log(ref: string, limit = 20): Promise<Array<{ commit: string; author: string; email: string; at: string; subject: string; body: string }>> {
    if (!(await this.rev(ref))) return [];
    const { stdout } = await this.run(['log', `-${limit}`, '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e', ref]);
    return stdout
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [commit, author, email, at, subject, body] = r.split('\x1f');
        return { commit: commit!, author: author!, email: email!, at: at!, subject: subject!, body: (body ?? '').trim() };
      });
  }

  /** a is an ancestor of (or equal to) b. */
  async isAncestor(a: string, b: string): Promise<boolean> {
    const { code } = await this.run(['merge-base', '--is-ancestor', a, b], { okCodes: [1] });
    return code === 0;
  }

  async deleteRef(ref: string): Promise<void> {
    await this.run(['update-ref', '-d', ref.startsWith('refs/') ? ref : `refs/heads/${ref}`], { okCodes: [1] });
  }
}
