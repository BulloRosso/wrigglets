import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GitRepo } from './git.js';

/*
 * A real Git host for the config repository (ADR-0049): Forgejo locally (an extension service), GitHub or Azure DevOps
 * in an enterprise. Proposals are pull requests; review, CODEOWNERS, branch protection and required checks are the
 * host's; validation is a commit status (`liquid/validate`); a merge to main arrives as a webhook and is reconciled.
 * The control plane acts as one bot account (site admin of the local Forgejo).
 */

export interface ForgeConfig {
  baseUrl: () => string;
  /** URL people open in the browser (e.g. http://localhost:3300). */
  publicUrl: string;
  bot: { user: string; password: () => string | undefined };
  owner: string;
  repo: string;
  webhookSecret: () => string | undefined;
}

export interface PullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  merged_by?: { login: string } | null;
  html_url: string;
  head: { ref: string; sha: string };
  title: string;
}

export class ForgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Forge {
  constructor(readonly cfg: ForgeConfig) {}

  private auth(user = this.cfg.bot.user, password = this.cfg.bot.password()) {
    if (!password) throw new ForgeError(503, 'the Git host credentials are missing');
    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }

  async api<T>(method: string, path: string, body?: unknown, as?: { user: string; password: string }): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl()}/api/v1${path}`, {
      method,
      headers: { authorization: as ? this.auth(as.user, as.password) : this.auth(), 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new ForgeError(res.status, `${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async ready(): Promise<boolean> {
    try {
      const r = await fetch(`${this.cfg.baseUrl()}/api/healthz`, { signal: AbortSignal.timeout(5000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  get repoPath() {
    return `/repos/${this.cfg.owner}/${this.cfg.repo}`;
  }
  get gitUrl() {
    return `${this.cfg.baseUrl()}/${this.cfg.owner}/${this.cfg.repo}.git`;
  }
  prUrl(n: number) {
    return `${this.cfg.publicUrl}/${this.cfg.owner}/${this.cfg.repo}/pulls/${n}`;
  }

  /** git arguments that authenticate one command (not stored in the repository config). */
  private gitAuth(): string[] {
    return ['-c', `http.extraHeader=Authorization: ${this.auth()}`];
  }

  /** Pushes a local ref to the host; false when the host rejects it (e.g. main moved: fetch and retry). */
  async push(git: GitRepo, local: string, remote = local, force = false): Promise<boolean> {
    const { code } = await git.run([...this.gitAuth(), 'push', '--porcelain', this.gitUrl, `${force ? '+' : ''}${local}:${remote}`], { okCodes: [1] });
    return code === 0;
  }

  /** Fetches a branch of the host into refs/forge/<branch>; returns its commit or null. */
  async fetch(git: GitRepo, branch: string): Promise<string | null> {
    const { code } = await git.run([...this.gitAuth(), 'fetch', '--no-tags', this.gitUrl, `+refs/heads/${branch}:refs/forge/${branch}`], { okCodes: [1, 128] });
    return code === 0 ? git.rev(`refs/forge/${branch}`) : null;
  }

  async openPr(o: { branch: string; title: string; body: string }): Promise<PullRequest> {
    return this.api<PullRequest>('POST', `${this.repoPath}/pulls`, { head: o.branch, base: 'main', title: o.title, body: o.body });
  }

  async pr(n: number): Promise<PullRequest> {
    return this.api<PullRequest>('GET', `${this.repoPath}/pulls/${n}`);
  }

  async status(sha: string, ok: boolean, description: string, targetUrl?: string) {
    await this.api('POST', `${this.repoPath}/statuses/${sha}`, { state: ok ? 'success' : 'failure', context: 'liquid/validate', description: description.slice(0, 140), target_url: targetUrl });
  }

  async comment(n: number, body: string) {
    await this.api('POST', `${this.repoPath}/issues/${n}/comments`, { body });
  }

  async close(n: number) {
    await this.api('PATCH', `${this.repoPath}/pulls/${n}`, { state: 'closed' });
  }

  /** Verifies the webhook signature (X-Forgejo-Signature / X-Gitea-Signature: hex HMAC-SHA256 of the body). */
  verify(body: Buffer, signature: string | undefined): boolean {
    const secret = this.cfg.webhookSecret();
    if (!secret || !signature) return false;
    const want = createHmac('sha256', secret).update(body).digest('hex');
    return want.length === signature.length && timingSafeEqual(Buffer.from(want), Buffer.from(signature));
  }
}

/** CODEOWNERS for the host from OWNERS.yaml: roles and teams map to host teams, e-mail addresses stay as they are. */
export function codeowners(owners: { teams: Record<string, string[]>; rules: Array<{ path: string; owners: string[] }> }, org: string, reviewersTeam: string): string {
  const ref = (o: string) => (o.startsWith('role:') || o.startsWith('team:') ? `@${org}/${reviewersTeam}` : o);
  const lines = owners.rules.map((r) => {
    const pattern = r.path === '**' ? '*' : r.path.replace(/\*\*$/, '');
    return `${pattern.startsWith('/') || pattern === '*' ? pattern : `/${pattern}`} ${[...new Set(r.owners.map(ref))].join(' ')}`;
  });
  return `# Generated from OWNERS.yaml by the control plane (ADR-0049). Edit OWNERS.yaml, not this file.\n${lines.join('\n')}\n`;
}
