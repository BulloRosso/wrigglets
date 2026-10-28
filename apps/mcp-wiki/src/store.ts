import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/*
 * Central company wiki (ADR-0035). Pages are Markdown; only people change them. Agents read and search, and they
 * PROPOSE edits that wait in a queue until a person approves, edits or rejects them. Every change keeps its provenance
 * (who, which task, why, evidence) and the previous versions of a page stay available.
 *
 * One JSON file, written atomically: the wiki is small by design (see the limits), and a Git repository would add a
 * dependency to the image without adding a reviewer.
 */

export const LIMITS = {
  pages: 200,
  pageChars: 32_000,
  versionsPerPage: 25,
  pendingPerAgent: 20,
  reasonMin: 10,
  reasonMax: 600,
  evidenceMax: 1_000,
};

const PATH = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*){0,3}\.md$/;

export class WikiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface PageVersion {
  at: string;
  by: string;
  note?: string;
  content: string;
}

interface PageRecord {
  path: string;
  content: string;
  updatedAt: string;
  updatedBy: string;
  /** Why the current text was published (for approved proposals: the proposal and its reason). */
  note?: string;
  versions: PageVersion[];
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface Proposal {
  id: string;
  path: string;
  /** Hash of the page when the proposal was written; null = the page did not exist. */
  base: string | null;
  content: string;
  reason: string;
  evidence: string;
  agent: string;
  task?: string;
  requestedBy?: string;
  createdAt: string;
  status: ProposalStatus;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  /** The page changed after the proposal was written (shown to the reviewer; the reviewer still decides). */
  baseChanged?: boolean;
  /** The reviewer approved a changed text instead of the proposed one. */
  edited?: boolean;
}

export interface PageInfo {
  path: string;
  title: string;
  updatedAt: string;
  updatedBy: string;
  chars: number;
  pending: number;
}

interface State {
  pages: Record<string, PageRecord>;
  proposals: Proposal[];
}

export const hashOf = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function checkPath(p: unknown): string {
  const v = String(p ?? '').trim();
  if (!PATH.test(v) || v.length > 100) throw new WikiError('Invalid page path: use lower-case letters, digits, "-" and "_", up to 4 folder levels, ending in .md (for example "protocols/handoff-to-procurement.md")');
  return v;
}

function checkContent(c: unknown): string {
  const v = String(c ?? '');
  if (!v.trim()) throw new WikiError('The page text is empty');
  if (v.length > LIMITS.pageChars) throw new WikiError(`The page text is too long (max ${LIMITS.pageChars} characters)`);
  if (v.includes('\0')) throw new WikiError('Invalid characters in the page text');
  return v.endsWith('\n') ? v : `${v}\n`;
}

const titleOf = (content: string, p: string) => (content.match(/^#\s+(.+)$/m)?.[1] ?? path.posix.basename(p, '.md')).trim().slice(0, 120);

export class WikiStore {
  private state: State = { pages: {}, proposals: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'wiki.json');
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8')) as State;
    } catch {
      await this.persist();
    }
  }

  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.state));
    await rename(`${this.file}.tmp`, this.file);
  }

  /** Writes are serialized, so two reviewers (or a reviewer and an agent) never interleave. */
  private write<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const r = await fn();
      await this.persist();
      return r;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /* ------------------------------------------------------------ reading */

  list(): PageInfo[] {
    return Object.values(this.state.pages)
      .map((p) => ({
        path: p.path,
        title: titleOf(p.content, p.path),
        updatedAt: p.updatedAt,
        updatedBy: p.updatedBy,
        chars: p.content.length,
        pending: this.state.proposals.filter((x) => x.status === 'pending' && x.path === p.path).length,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  read(p: string) {
    const rec = this.state.pages[checkPath(p)];
    return rec ? { path: rec.path, content: rec.content, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy, note: rec.note, hash: hashOf(rec.content), versions: rec.versions.length } : undefined;
  }

  versions(p: string) {
    return (this.state.pages[checkPath(p)]?.versions ?? []).map((v, i) => ({ index: i, at: v.at, by: v.by, note: v.note, chars: v.content.length })).reverse();
  }

  version(p: string, index: number) {
    return this.state.pages[checkPath(p)]?.versions[index];
  }

  search(query: string, limit = 8) {
    const tokens = String(query ?? '')
      .toLowerCase()
      .split(/[^a-z0-9äöüß]+/)
      .filter((t) => t.length > 1)
      .slice(0, 8);
    if (!tokens.length) return [];
    const out: Array<{ path: string; title: string; score: number; snippet: string }> = [];
    for (const rec of Object.values(this.state.pages)) {
      const text = rec.content.toLowerCase();
      const title = titleOf(rec.content, rec.path).toLowerCase();
      let score = 0;
      for (const t of tokens) {
        score += (title.includes(t) ? 5 : 0) + (rec.path.includes(t) ? 3 : 0) + Math.min(text.split(t).length - 1, 10);
      }
      if (!score) continue;
      const at = Math.max(0, text.indexOf(tokens.find((t) => text.includes(t)) ?? ''));
      out.push({ path: rec.path, title: titleOf(rec.content, rec.path), score, snippet: rec.content.slice(Math.max(0, at - 60), at + 160).replace(/\s+/g, ' ').trim() });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /* ------------------------------------------------------------ people write pages */

  /** A person creates or replaces a page. */
  async put(p: string, content: string, by: string, note?: string) {
    const rel = checkPath(p);
    const text = checkContent(content);
    return this.write(() => this.apply(rel, text, by, note));
  }

  private apply(rel: string, text: string, by: string, note?: string) {
    const now = new Date().toISOString();
    const rec = this.state.pages[rel];
    if (!rec && Object.keys(this.state.pages).length >= LIMITS.pages) throw new WikiError(`The wiki is full (max ${LIMITS.pages} pages)`);
    const versions = [...(rec?.versions ?? []), ...(rec ? [{ at: rec.updatedAt, by: rec.updatedBy, note: rec.note, content: rec.content }] : [])].slice(-LIMITS.versionsPerPage);
    this.state.pages[rel] = { path: rel, content: text, updatedAt: now, updatedBy: by, note, versions };
    return { path: rel, hash: hashOf(text) };
  }

  async remove(p: string, by: string) {
    const rel = checkPath(p);
    return this.write(() => {
      if (!this.state.pages[rel]) throw new WikiError('Page not found', 404);
      delete this.state.pages[rel];
      for (const pr of this.state.proposals) if (pr.path === rel && pr.status === 'pending') Object.assign(pr, { status: 'rejected', decidedBy: by, decidedAt: new Date().toISOString(), comment: 'The page was removed' });
    });
  }

  /* ------------------------------------------------------------ agents propose */

  async propose(input: { path: string; content: string; reason: string; evidence?: string; agent: string; task?: string; requestedBy?: string }): Promise<Proposal> {
    const rel = checkPath(input.path);
    const text = checkContent(input.content);
    const reason = String(input.reason ?? '').trim();
    if (reason.length < LIMITS.reasonMin) throw new WikiError(`Say why the page should change (at least ${LIMITS.reasonMin} characters)`);
    return this.write(() => {
      const current = this.state.pages[rel];
      if (current && current.content === text) throw new WikiError('The proposed text is identical to the current page');
      if (this.state.proposals.filter((x) => x.status === 'pending' && x.agent === input.agent).length >= LIMITS.pendingPerAgent) {
        throw new WikiError(`There are already ${LIMITS.pendingPerAgent} proposals of ${input.agent} waiting for review`, 429);
      }
      if (!current && Object.keys(this.state.pages).length >= LIMITS.pages) throw new WikiError(`The wiki is full (max ${LIMITS.pages} pages)`);
      const p: Proposal = {
        id: randomUUID().slice(0, 8),
        path: rel,
        base: current ? hashOf(current.content) : null,
        content: text,
        reason: reason.slice(0, LIMITS.reasonMax),
        evidence: String(input.evidence ?? '').slice(0, LIMITS.evidenceMax),
        agent: input.agent,
        task: input.task,
        requestedBy: input.requestedBy,
        createdAt: new Date().toISOString(),
        status: 'pending',
      };
      this.state.proposals.push(p);
      if (this.state.proposals.length > 1000) this.state.proposals = this.state.proposals.filter((x) => x.status === 'pending').concat(this.state.proposals.filter((x) => x.status !== 'pending').slice(-500));
      return p;
    });
  }

  proposals(filter: { status?: ProposalStatus; agent?: string } = {}) {
    return this.state.proposals
      .filter((p) => (!filter.status || p.status === filter.status) && (!filter.agent || p.agent === filter.agent))
      .map((p) => ({ ...p, current: this.state.pages[p.path]?.content ?? null, baseChanged: p.status === 'pending' ? (this.state.pages[p.path] ? hashOf(this.state.pages[p.path]!.content) : null) !== p.base : p.baseChanged }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A person decides. `content` lets the reviewer approve a corrected text instead of the proposed one. */
  decide(id: string, decision: 'approve' | 'reject', by: string, comment?: string, content?: string) {
    return this.write(() => {
      const p = this.state.proposals.find((x) => x.id === id);
      if (!p) throw new WikiError('Proposal not found', 404);
      if (p.status !== 'pending') throw new WikiError(`The proposal was already ${p.status}`, 409);
      if (decision === 'reject' && !String(comment ?? '').trim()) throw new WikiError('A rejection needs a comment: the agent reads it');
      const now = new Date().toISOString();
      p.baseChanged = (this.state.pages[p.path] ? hashOf(this.state.pages[p.path]!.content) : null) !== p.base;
      if (decision === 'approve') {
        const text = content === undefined ? p.content : checkContent(content);
        p.edited = text !== p.content;
        this.apply(p.path, text, by, `Proposal ${p.id} of ${p.agent}${p.edited ? ' (edited by the reviewer)' : ''}: ${p.reason}`.slice(0, 300));
      }
      Object.assign(p, { status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: by, decidedAt: now, comment: comment?.trim() || undefined });
      return p;
    });
  }
}
