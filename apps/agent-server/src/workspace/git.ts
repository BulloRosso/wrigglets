import { execFile } from 'node:child_process';
import type { CommitInfo } from '@cw/shared';

/*
 * Thin wrapper around the git CLI (spec §8). Only activities commit; the harness has read-only
 * git permissions.
 */

export interface GitResult {
  stdout: string;
  stderr: string;
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

export type Trailers = Record<string, string | string[] | undefined>;

/** Paths a restore leaves as they are: records of what was done and protected platform files. */
const KEEP_ON_RESTORE = ['.agent', 'AGENTS.md', 'opencode.json', 'opencode.jsonc', '.opencode'];

const FIELD = '\x1f';
const RECORD = '\x1e';

export class Git {
  constructor(readonly cwd: string) {}

  run(args: string[], opts: { input?: string; env?: Record<string, string>; allowFail?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        {
          cwd: this.cwd,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env },
        },
        (err, stdout, stderr) => {
          if (err && !opts.allowFail) {
            reject(new GitError(`git ${args[0]} failed: ${stderr.trim() || err.message}`, (err as { code?: number }).code ?? null, stderr));
          } else resolve({ stdout, stderr });
        },
      );
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input);
      }
    });
  }

  async head(): Promise<string | undefined> {
    const r = await this.run(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
    return r.stdout.trim() || undefined;
  }

  async isDirty(): Promise<boolean> {
    const r = await this.run(['status', '--porcelain', '--untracked-files=all']);
    return r.stdout.trim().length > 0;
  }

  async changedFiles(): Promise<string[]> {
    const r = await this.run(['status', '--porcelain', '--untracked-files=all', '-z']);
    return r.stdout
      .split('\0')
      .filter(Boolean)
      .map((l) => l.slice(3));
  }

  /** Discard every uncommitted change (spec §8.3), keeping `.agent/steps/`. */
  async resetToHead(): Promise<void> {
    if (await this.head()) await this.run(['reset', '--hard', 'HEAD']);
    await this.run(['clean', '-fd', '-e', '.agent/steps/']);
  }

  async commitAll(opts: {
    subject: string;
    body?: string;
    trailers: Trailers;
    author?: { name: string; email: string };
    allowEmpty?: boolean;
  }): Promise<string> {
    await this.run(['add', '-A']);
    const message = formatCommitMessage(opts.subject, opts.body, opts.trailers);
    const args = ['commit', '-q', '--no-verify', '-F', '-'];
    if (opts.allowEmpty !== false) args.push('--allow-empty');
    if (opts.author) args.push(`--author=${opts.author.name} <${opts.author.email}>`);
    await this.run(args, { input: message });
    return (await this.head())!;
  }

  /** Commits only the given paths, leaving any other (e.g. task-in-progress) changes untouched. */
  async commitPaths(
    paths: string[],
    opts: { subject: string; trailers: Trailers; author: { name: string; email: string } },
  ): Promise<string | undefined> {
    await this.run(['add', '--', ...paths]);
    const diff = await this.run(['diff', '--cached', '--name-only', '--', ...paths]);
    if (!diff.stdout.trim()) return undefined;
    const message = formatCommitMessage(opts.subject, undefined, opts.trailers);
    await this.run(['commit', '-q', '--no-verify', '-F', '-', `--author=${opts.author.name} <${opts.author.email}>`, '--only', '--', ...paths], { input: message });
    return this.head();
  }

  async findCommitByTrailer(key: string, value: string): Promise<string | undefined> {
    if (!(await this.head())) return undefined;
    const r = await this.run(['log', '--all', '-F', `--grep=${key}: ${value}`, `--format=%H${FIELD}%(trailers:key=${key},valueonly,separator=%x1d)`]);
    for (const line of r.stdout.split('\n')) {
      const [hash, values] = line.split(FIELD);
      if (hash && values?.split('\x1d').some((v) => v.trim() === value)) return hash;
    }
    return undefined;
  }

  async log(opts: { path?: string; limit?: number; grep?: string; pickaxe?: string; files?: boolean; ignoreCase?: boolean } = {}): Promise<CommitInfo[]> {
    if (!(await this.head())) return [];
    const fmt = ['%H', '%h', '%an', '%ae', '%cn', '%ce', '%cI', '%s', '%b', '%(trailers:unfold,only)'].join(FIELD);
    const args = ['log', `--max-count=${opts.limit ?? 50}`, `--format=${RECORD}${fmt}`];
    if (opts.files) args.push('--name-only');
    if (opts.ignoreCase) args.push('-i');
    if (opts.grep) args.push('-F', `--grep=${opts.grep}`);
    if (opts.pickaxe) args.push(`-S${opts.pickaxe}`);
    if (opts.path) args.push('--', opts.path);
    const r = await this.run(args);
    return r.stdout
      .split(RECORD)
      .filter((s) => s.trim())
      .map((rec) => parseLogRecord(rec, !!opts.files));
  }

  /**
   * Sets the working files to the state of `hash` as a NEW commit on top of the current history, so nothing is lost
   * and the audit trail stays complete. Platform records (`.agent/`, AGENTS.md, opencode config) keep their current
   * state. Returns undefined when the workspace already matches.
   */
  async restoreTo(
    hash: string,
    opts: { subject: string; trailers: Trailers; author: { name: string; email: string } },
  ): Promise<string | undefined> {
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('invalid commit hash');
    await this.run(['cat-file', '-e', `${hash}^{commit}`]);
    if (await this.isDirty()) await this.resetToHead();
    await this.run(['read-tree', '-u', '--reset', hash]);
    for (const p of KEEP_ON_RESTORE) {
      await this.run(['rm', '-rfq', '--ignore-unmatch', '--', p]);
      await this.run(['checkout', 'HEAD', '--', p], { allowFail: true });
    }
    await this.run(['add', '-A']);
    if (!(await this.run(['diff', '--cached', '--name-only'])).stdout.trim()) return undefined;
    await this.run(['commit', '-q', '--no-verify', '-F', '-', `--author=${opts.author.name} <${opts.author.email}>`], {
      input: formatCommitMessage(opts.subject, undefined, opts.trailers),
    });
    return this.head();
  }

  async show(hash: string): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('invalid commit hash');
    const r = await this.run(['show', '--format=fuller', '--stat', '--patch', '--no-color', hash]);
    return r.stdout;
  }
}

export function formatCommitMessage(subject: string, body: string | undefined, trailers: Trailers): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(trailers)) {
    const values = Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v];
    for (const value of values) lines.push(`${k}: ${String(value).replace(/\s*\n\s*/g, ' ')}`);
  }
  const cleanSubject = subject.replace(/\s*\n\s*/g, ' ').trim();
  return [cleanSubject, '', ...(body?.trim() ? [body.trim(), ''] : []), ...lines, ''].join('\n');
}

export function parseTrailers(block: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/.exec(line.trim());
    if (!m) continue;
    (out[m[1]!] ??= []).push(m[2]!);
  }
  return out;
}

function parseLogRecord(rec: string, withFiles: boolean): CommitInfo {
  const parts = rec.split(FIELD);
  const [hash, shortHash, an, ae, cn, ce, date, subject, body = ''] = parts;
  let trailerBlock = parts[9] ?? '';
  let files: string[] | undefined;
  if (withFiles) {
    // With --name-only the file list follows the formatted message after a blank line.
    const idx = trailerBlock.indexOf('\n\n');
    const tail = idx >= 0 ? trailerBlock.slice(idx + 2) : '';
    trailerBlock = idx >= 0 ? trailerBlock.slice(0, idx) : trailerBlock;
    files = tail.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const trailers = parseTrailers(trailerBlock);
  const trailerLines = new Set(trailerBlock.split('\n').map((l) => l.trim()).filter(Boolean));
  const cleanBody = body
    .split('\n')
    .filter((l) => !trailerLines.has(l.trim()))
    .join('\n')
    .trim();
  return {
    hash: hash!.trim(),
    shortHash: shortHash!,
    author: { name: an!, email: ae! },
    committer: { name: cn!, email: ce! },
    date: date!,
    subject: subject!,
    body: cleanBody,
    trailers,
    files,
  };
}
