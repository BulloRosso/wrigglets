import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { canonical, compatibility, diffIr, sourceHash, type Compatibility, type IrDiff, type OntologyIr } from '@cw/ontology-ir';
import { GitRepo, type Author } from './git.js';
import { codeowners, type Forge, type PullRequest } from './forge.js';
import { DEFAULT_OWNERS, MANAGED_PREFIXES, README, ROOT_FILES, STORE_FILES, exportState, findSecrets, ownersFile, parseState, requiredOwners, type DesiredState } from './layout.js';

/*
 * Config repository (ADR-0046): the platform's desired state in Git (bare repo in /data/liquid/config.git, outside
 * /data/admin), branch main applied by a reconciler; changes from the console become commits; agents and people
 * propose changes on branches, validated before anyone can approve, approved by the owners of the touched paths.
 */

export interface ConfigTargets {
  /** The admin stores as they are now. */
  current(): DesiredState;
  /** Make the stores match `desired`; returns human-readable changes (empty = nothing to do). */
  apply(desired: DesiredState, by: string): Promise<string[]>;
  /** Secret values that must never appear in the repository. */
  secrets(): string[];
}

export interface Validators {
  compileOntology?(files: Record<string, string>): Promise<{ ok: boolean; ir?: OntologyIr; errors?: Array<{ path: string; message: string }> }>;
  checkRego?(files: Record<string, string>): Promise<{ ok: boolean; errors: Array<{ path: string; message: string }> }>;
  /** Data check of a candidate ontology against the objects that exist (ontology server, M8). */
  checkOntology?(ir: OntologyIr): Promise<{ data: { ok: boolean; findings: Array<{ path: string; problem: string; rows: number }> } }>;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
}

export interface Proposal {
  id: string;
  title: string;
  reason: string;
  evidence?: string;
  author: { kind: 'agent' | 'person'; id: string; user?: string; task?: string };
  createdAt: string;
  base: string;
  branch: string;
  head: string;
  paths: string[];
  status: 'pending' | 'approved' | 'rejected' | 'conflict';
  validation: { ok: boolean; at: string; checks: Check[] };
  owners: Array<{ for: string; owners: string[] }>;
  irDiff?: IrDiff;
  /** Compatibility class of an ontology change (M8, E4): patch | minor | major. */
  compat?: Compatibility;
  /** Required for a breaking (major) ontology change. */
  migrationNote?: string;
  /** The pull request on the Git host (ADR-0049), when one is configured. */
  pr?: { number: number; url: string };
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  mergedAs?: string;
  changeId: string;
}

interface Meta {
  applied: string | null;
  /** Seed files ever added (a later version adds new defaults once; files removed on purpose stay removed). */
  seeded?: string[];
  /** The Git host was set up (repository pushed, protection, webhook): proposals go there (ADR-0049). */
  forgeReady?: boolean;
  /** Hash of the ontology files last applied to the ontology server (M8). */
  ontologyHash?: Record<string, string>;
  lastReconcile: { at: string; head: string | null; ok: boolean; changes: string[]; errors: Array<{ path: string; message: string }> } | null;
  proposals: Proposal[];
}

export class ConfigError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SYSTEM: Author = { name: 'Liquid reconciler', email: 'reconciler@liquid.local' };
const personAuthor = (email: string): Author => ({ name: email.split('@')[0] || email, email: email.includes('@') ? email : `${email}@agents.local` });
const trailers = (t: Record<string, string | undefined>) =>
  Object.entries(t)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
const ontologyFiles = (files: Record<string, string>, domain: string) => {
  const f = (n: string) => files[`ontology/${domain}/${n}`];
  return f('schema.yaml') !== undefined && f('actions.yaml') !== undefined && f('bindings.yaml') !== undefined ? { 'schema.yaml': f('schema.yaml')!, 'actions.yaml': f('actions.yaml')!, 'bindings.yaml': f('bindings.yaml')! } : undefined;
};
const domainsOf = (paths: string[]) => [...new Set(paths.filter((p) => p.startsWith('ontology/')).map((p) => p.split('/')[1]!))];
const PATH_OK = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/;

export class ConfigRepoService {
  readonly git: GitRepo;
  private meta: Meta = { applied: null, lastReconcile: null, proposals: [] };
  private readonly metaFile: string;
  private chain: Promise<unknown> = Promise.resolve();
  /** Console edits whose capture is still to come: a reconcile must not take them for drift and revert them. */
  private editsInFlight = 0;
  /** Last reconcile run of any outcome (also "nothing to do"), for the health view; not persisted. */
  private lastRunAt?: string;
  /** When the stores may be written at all (installed, no extension operation running). Checked by every reconcile,
   *  whoever triggers it (timer, webhook, deferred edit), and again right before applying (ADR-0051). */
  gate: () => boolean = () => true;
  /** Called after main changed through a proposal or a reconcile applied something (e.g. to rebuild the OPA bundle). */
  onApplied?: () => void;
  /** The Git host (Forgejo, GitHub, Azure DevOps): proposals become pull requests, decisions happen there (ADR-0049). */
  forge?: Forge;
  /** URL of a proposal in the admin console (for commit statuses). */
  consoleUrl = (id: string) => `http://localhost:8080/liquid/proposals/${id}`;

  /** A reconcile that changed something or failed (recorded as an event, ADR-0049). */
  onReconciled?: (r: { head: string; ok: boolean; changes: string[]; errors: Array<{ path: string; message: string }> }) => void;
  /** Source-file hashes of the ontology the enterprise core runs now (IR.source.files), to detect a reset core. */
  ontologyInForce?: (domain: string) => Promise<Record<string, string> | undefined>;
  /** Applies the ontology of a domain to the ontology server when its files changed (M8). Returns a change summary. */
  onOntology?: (domain: string, files: { 'schema.yaml': string; 'actions.yaml': string; 'bindings.yaml': string }, note?: string) => Promise<string | undefined>;

  constructor(
    readonly dir: string,
    private readonly targets: ConfigTargets,
    private readonly validators: Validators = {},
    private readonly regoData: () => Promise<string | undefined> = async () => undefined,
  ) {
    this.git = new GitRepo(path.join(dir, 'config.git'));
    this.metaFile = path.join(dir, 'config-meta.json');
  }

  /** Serialises writers (console capture, proposals, reconcile) in this process. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async load() {
    try {
      this.meta = { ...this.meta, ...(JSON.parse(await readFile(this.metaFile, 'utf8')) as Meta) };
    } catch {
      /* first start */
    }
  }

  /** Uninstall with delete data (the files are removed by the caller): forget everything held in memory. */
  async reset() {
    return this.serial(async () => {
      this.meta = { applied: null, lastReconcile: null, proposals: [] };
      this.forge = undefined;
      this.lastRunAt = undefined;
    });
  }

  private async persist() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(`${this.metaFile}.tmp`, JSON.stringify(this.meta, null, 2));
    await rename(`${this.metaFile}.tmp`, this.metaFile);
  }

  async initialized(): Promise<boolean> {
    return (await this.git.exists()) && !!(await this.git.rev('main'));
  }

  /** Bootstrap: first commit = the running platform's state + ontology + policies + OWNERS. Idempotent. */
  async init(seed: Record<string, string>, by: string): Promise<{ created: boolean; head: string }> {
    return this.serial(async () => {
      await this.git.init();
      const existing = await this.git.rev('main');
      if (existing) {
        // new default files of a newer version (e.g. playbooks) are added once
        const have = new Set(await this.git.paths(existing));
        const seeded = new Set(this.meta.seeded ?? [...have]);
        const add = Object.fromEntries(Object.entries(seed).filter(([p]) => !have.has(p) && !seeded.has(p)));
        let head = existing;
        if (Object.keys(add).length) {
          this.guard(add);
          head = (await this.git.commit({ ref: 'main', parent: existing, changes: add, message: `Add default files of this version: ${Object.keys(add).sort().join(', ')}

${trailers({ 'Requested-By': by, 'Change-Id': randomUUID() })}`, author: personAuthor(by), committer: SYSTEM })) ?? existing;
        }
        this.meta.seeded = [...new Set([...seeded, ...Object.keys(seed)])].sort();
        await this.persist();
        return { created: false, head };
      }
      const files = { 'README.md': README, 'OWNERS.yaml': DEFAULT_OWNERS, 'playbooks/README.md': '# Playbooks (M7)\n', ...seed, ...exportState(this.targets.current()) };
      this.guard(files);
      const head = (await this.git.commit({ ref: 'main', parent: null, expect: null, changes: files, message: `Bootstrap config repository from the running platform\n\n${trailers({ 'Requested-By': by, 'Change-Id': randomUUID() })}`, author: personAuthor(by), committer: SYSTEM }))!;
      this.meta.applied = head;
      this.meta.seeded = Object.keys(seed).sort();
      await this.persist();
      return { created: true, head };
    });
  }

  private guard(files: Record<string, string>) {
    const leaked = findSecrets(files, this.targets.secrets());
    if (leaked.length) throw new ConfigError(422, `refusing to commit: secret values found in ${leaked.join(', ')}`);
  }

  beginEdit() {
    this.editsInFlight++;
  }
  endEdit() {
    this.editsInFlight = Math.max(0, this.editsInFlight - 1);
  }

  /** Commit-on-edit: an admin console change of a store becomes a commit on main (author = the signed-in admin). */
  async capture(by: string, what: string): Promise<string | null> {
    if (!(await this.initialized())) return null;
    return this.serial(async () => {
      const main = (await this.git.rev('main'))!;
      const now = await this.git.files(main);
      const next = exportState(this.targets.current());
      const changes: Record<string, string | null> = {};
      for (const [p, text] of Object.entries(next)) if (now[p] !== text) changes[p] = text;
      for (const p of Object.keys(now)) if (STORE_FILES(p) && !(p in next)) changes[p] = null;
      if (!Object.keys(changes).length) return null;
      this.guard(Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null)) as Record<string, string>);
      const head = await this.git.commit({ ref: 'main', parent: main, changes, message: `console: ${what}\n\n${trailers({ 'Requested-By': by, 'Change-Id': randomUUID() })}`, author: personAuthor(by), committer: SYSTEM });
      // the stores already have this state; only skip the apply if nothing else was pending
      if (head && this.meta.applied === main) this.meta.applied = head;
      await this.persist();
      if (head && this.forge && !(await this.forge.push(this.git, 'refs/heads/main'))) {
        // main moved on the host meanwhile (a merge): take the host's main, the next capture/reconcile settles it
        await this.syncUnlocked();
      }
      return head;
    });
  }

  /** Validate main → apply to the stores → record the applied revision. Runs every 60 s and after each merge. */
  async reconcile(by = 'reconciler', force = false) {
    if (!(await this.initialized())) return { ok: false, skipped: 'repository not initialised' } as const;
    return this.serial(async () => {
      this.lastRunAt = new Date().toISOString();
      if (!this.gate()) return { ok: true, head: null, changes: [] as string[], unchanged: true, skipped: 'paused (not installed or an extension operation is running)' };
      if (this.forge) {
        await this.syncUnlocked().catch(() => undefined);
        await this.settleFromHost().catch(() => undefined);
      }
      const head = (await this.git.rev('main'))!;
      // a console edit is being captured: its store change is not drift; the next run sees it committed
      if (this.editsInFlight > 0) return { ok: true, head, changes: [] as string[], unchanged: true, deferred: true };
      // applied and the stores still match main (e.g. not reset by an empty /data/admin) → nothing to do
      if (!force && head === this.meta.applied && this.meta.lastReconcile?.ok !== false && (await this.driftAt(head)).length === 0 && (!this.onOntology || (this.meta.ontologyHash && (await this.ontologyMatches(head)))))
        return { ok: true, head, changes: [] as string[], unchanged: true };
      const files = await this.git.files(head);
      const { state, errors } = parseState(files);
      const leaked = findSecrets(files, this.targets.secrets());
      if (leaked.length) errors.push(...leaked.map((p) => ({ path: p, message: 'contains a secret value' })));
      if (!state || errors.length) {
        this.meta.lastReconcile = { at: new Date().toISOString(), head, ok: false, changes: [], errors };
        await this.persist();
        this.onReconciled?.({ head, ok: false, changes: [], errors });
        return { ok: false, head, errors };
      }
      if (!this.gate()) return { ok: true, head, changes: [] as string[], unchanged: true, skipped: 'paused (an extension operation started)' };
      const changes = await this.targets.apply(state, by);
      // ontology versions (M8): a changed domain is compiled and applied to the ontology server while it runs
      if (this.onOntology) {
        for (const d of domainsOf(Object.keys(files))) {
          const of = ontologyFiles(files, d);
          if (!of) continue;
          const h = createHash('sha256').update(canonical(of)).digest('hex');
          // what the core runs is the truth (it may have been reset, e.g. after a reinstall): compare its source hashes
          const inForce = await this.ontologyInForce?.(d).catch(() => undefined);
          const same = inForce ? Object.entries(of).every(([n, t]) => inForce[n] === sourceHash(t)) : this.meta.ontologyHash?.[d] === h;
          if (same) {
            (this.meta.ontologyHash ??= {})[d] = h;
            continue;
          }
          try {
            const note = [...this.meta.proposals].reverse().find((p) => p.status === 'approved' && p.paths.some((x) => x.startsWith(`ontology/${d}/`)))?.migrationNote;
            const summary = await this.onOntology(d, of, note);
            if (summary) changes.push(summary);
            (this.meta.ontologyHash ??= {})[d] = h;
          } catch (err) {
            this.meta.lastReconcile = { at: new Date().toISOString(), head, ok: false, changes, errors: [{ path: `ontology/${d}`, message: (err as Error).message }] };
            await this.persist();
            this.onReconciled?.({ head, ok: false, changes, errors: this.meta.lastReconcile.errors });
            return { ok: false, head, errors: this.meta.lastReconcile.errors };
          }
        }
      }
      this.meta.applied = head;
      this.meta.lastReconcile = { at: new Date().toISOString(), head, ok: true, changes, errors: [] };
      await this.persist();
      if (changes.length || force) this.onApplied?.();
      if (changes.length) this.onReconciled?.({ head, ok: true, changes, errors: [] });
      return { ok: true, head, changes };
    });
  }

  /** Files of the applied revision under a prefix (e.g. the policies for the OPA bundle). */
  async appliedFiles(prefix: string): Promise<Record<string, string> | undefined> {
    if (!this.meta.applied || !(await this.git.exists())) return undefined;
    return this.git.files(this.meta.applied, prefix);
  }

  async status() {
    const init = await this.initialized();
    const head = init ? await this.git.rev('main') : null;
    return {
      initialized: init,
      head,
      applied: this.meta.applied,
      inSync: !!head && head === this.meta.applied,
      lastReconcile: this.meta.lastReconcile,
      lastRunAt: this.lastRunAt ?? null,
      pendingProposals: this.meta.proposals.filter((p) => p.status === 'pending').length,
      log: init ? await this.git.log('main', 15) : [],
      files: head ? (await this.git.paths(head)).sort() : [],
    };
  }

  async read(p?: string, rev = 'main'): Promise<{ path: string; content: string } | { files: string[] }> {
    const r = await this.git.rev(rev);
    if (!r) throw new ConfigError(404, 'the config repository is not initialised');
    if (!p) return { files: (await this.git.paths(r)).sort() };
    const content = await this.git.file(r, p);
    if (content === null) throw new ConfigError(404, `no file ${p}`);
    return { path: p, content };
  }

  /* ------------------------------------------------------------------------------------------ proposals */

  list(filter: { status?: Proposal['status']; agent?: string } = {}) {
    return this.meta.proposals.filter((p) => (!filter.status || p.status === filter.status) && (!filter.agent || p.author.id === filter.agent)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string) {
    const p = this.meta.proposals.find((x) => x.id === id);
    if (!p) throw new ConfigError(404, `no proposal ${id}`);
    return { ...p, diff: await this.git.diff(p.base, p.head).catch(() => '') };
  }

  async propose(input: { title: string; reason: string; evidence?: string; migrationNote?: string; changes: Array<{ path: string; content: string | null }>; author: Proposal['author'] }): Promise<Proposal> {
    if (!(await this.initialized())) throw new ConfigError(409, 'the config repository is not initialised');
    const title = input.title.trim().slice(0, 140);
    const reason = input.reason.trim().slice(0, 4000);
    if (title.length < 3 || reason.length < 3) throw new ConfigError(400, 'title and reason are required');
    if (!input.changes.length || input.changes.length > 50) throw new ConfigError(400, 'between 1 and 50 file changes');
    for (const c of input.changes) {
      if (!PATH_OK.test(c.path) || c.path.split('/').includes('..') || (!(ROOT_FILES as readonly string[]).includes(c.path) && !MANAGED_PREFIXES.some((x) => c.path.startsWith(x)))) throw new ConfigError(400, `path ${c.path} is outside the config repository layout`);
      if (c.content !== null && Buffer.byteLength(c.content) > 512 * 1024) throw new ConfigError(413, `${c.path} is larger than 512 KiB`);
    }
    return this.serial(async () => {
      const base = (await this.git.rev('main'))!;
      const id = `cp-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
      const branch = `proposal/${id}`;
      const changes = Object.fromEntries(input.changes.map((c) => [c.path, c.content]));
      this.guard(Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null)) as Record<string, string>);
      const author = input.author.kind === 'agent' ? { name: input.author.id, email: `${input.author.id}@agents.local` } : personAuthor(input.author.id);
      const changeId = randomUUID();
      const head = await this.git.commit({ ref: branch, parent: base, expect: null, changes, message: `${title}\n\n${reason}\n\n${trailers({ 'Requested-By': input.author.user ?? (input.author.kind === 'person' ? input.author.id : undefined), Agent: input.author.kind === 'agent' ? input.author.id : undefined, Task: input.author.task, 'Change-Id': changeId })}`, author, committer: SYSTEM });
      if (!head) throw new ConfigError(422, 'the proposal changes nothing');
      const paths = await this.git.changedPaths(base, head);
      const p: Proposal = { id, title, reason, evidence: input.evidence?.slice(0, 8000), migrationNote: input.migrationNote?.trim().slice(0, 4000) || undefined, author: input.author, createdAt: new Date().toISOString(), base, branch, head, paths, status: 'pending', validation: { ok: false, at: '', checks: [] }, owners: [], changeId };
      await this.validateInto(p, head);
      if (this.forge) await this.openPullRequest(p);
      this.meta.proposals.push(p);
      await this.persist();
      return p;
    });
  }

  /* ------------------------------------------------------------------------------------------ Git host (ADR-0049) */

  private prBody(p: Proposal): string {
    const who = p.author.kind === 'agent' ? `Agent \`${p.author.id}\`${p.author.user ? ` on behalf of ${p.author.user}` : ''}${p.author.task ? ` (task ${p.author.task})` : ''}` : p.author.id;
    const checks = p.validation.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`).join('\n');
    return `${p.reason}\n\n**Proposed by:** ${who}\n${p.compat ? `**Ontology compatibility:** ${p.compat.level} (suggested version ${p.compat.suggestedVersion})\n` : ''}${p.migrationNote ? `**Migration note:** ${p.migrationNote}\n` : ''}\n**Validation (liquid/validate):**\n${checks}\n\n${p.evidence ? `<details><summary>Evidence</summary>\n\n${p.evidence.slice(0, 6000)}\n\n</details>\n\n` : ''}Review, diff graph and history: ${this.consoleUrl(p.id)}`;
  }

  private async openPullRequest(p: Proposal) {
    const f = this.forge!;
    if (!(await f.push(this.git, `refs/heads/${p.branch}`, `refs/heads/${p.branch}`, true))) throw new ConfigError(502, 'could not push the proposal branch to the Git host');
    const pr = await f.openPr({ branch: p.branch, title: p.title, body: this.prBody(p) });
    p.pr = { number: pr.number, url: f.prUrl(pr.number) };
    await f.status(p.head, p.validation.ok, p.validation.ok ? 'valid' : `invalid: ${p.validation.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`, this.consoleUrl(p.id));
  }

  /** Brings the local main in line with the host's main (the host is where merges happen). */
  async sync() {
    return this.serial(() => this.syncUnlocked());
  }

  private async syncUnlocked(): Promise<{ local: string | null; remote: string | null; action: string }> {
    const f = this.forge;
    if (!f) return { local: null, remote: null, action: 'no host' };
    const local = await this.git.rev('main');
    const remote = await f.fetch(this.git, 'main');
    if (!remote || !local || remote === local) {
      if (!remote && local) await f.push(this.git, 'refs/heads/main');
      return { local, remote, action: remote ? 'in sync' : 'pushed' };
    }
    if (await this.git.isAncestor(local, remote)) {
      await this.git.run(['update-ref', 'refs/heads/main', remote, local]);
      return { local, remote, action: 'fast-forward from host' };
    }
    if (await this.git.isAncestor(remote, local)) {
      await f.push(this.git, 'refs/heads/main');
      return { local, remote, action: 'pushed to host' };
    }
    // diverged (should not happen: the host's main is protected, only the bot pushes): the host wins
    await this.git.run(['update-ref', 'refs/heads/main', remote, local]);
    return { local, remote, action: 'diverged: took the host' };
  }

  get forgeReady() {
    return !!this.meta.forgeReady;
  }

  async markForgeReady() {
    this.meta.forgeReady = true;
    await this.persist();
  }

  /** CODEOWNERS for the host from OWNERS.yaml (committed to main by the bot). */
  async writeCodeowners(org: string, team: string): Promise<string | null> {
    return this.serial(async () => {
      const main = (await this.git.rev('main'))!;
      const owners = ownersFile.safeParse(YAML.parse((await this.git.file(main, 'OWNERS.yaml')) ?? DEFAULT_OWNERS));
      if (!owners.success) return null;
      const text = codeowners(owners.data, org, team);
      if ((await this.git.file(main, '.forgejo/CODEOWNERS')) === text) return null;
      const head = await this.git.commit({ ref: 'main', parent: main, changes: { '.forgejo/CODEOWNERS': text }, message: `CODEOWNERS from OWNERS.yaml\n\n${trailers({ 'Change-Id': randomUUID() })}`, author: SYSTEM });
      if (head && this.meta.applied === main) this.meta.applied = head;
      await this.persist();
      if (head && this.forge) await this.forge.push(this.git, 'refs/heads/main');
      return head;
    });
  }

  /**
   * Webhooks can be lost (the control plane restarting, the host dropping a delivery) and a proposal can outlive its
   * pull request (the host recreated by a reinstall with purge). Each reconcile therefore compares the pending
   * proposals with the host: merged → approved, closed → rejected, gone or the number now used by another branch →
   * rejected with a note. A host that cannot be reached settles nothing (try again next run).
   */
  private async settleFromHost(): Promise<number> {
    const f = this.forge;
    if (!f) return 0;
    let n = 0;
    // proposals made while the host was not reachable (or before it was set up) get their pull request now
    for (const p of this.meta.proposals.filter((x) => x.status === 'pending' && !x.pr)) {
      try {
        await this.openPullRequest(p);
        n++;
      } catch {
        return n; // host not ready: try again next run
      }
    }
    for (const p of this.meta.proposals.filter((x) => x.status === 'pending' && x.pr)) {
      let pr: (PullRequest & { merge_commit_sha?: string }) | undefined;
      try {
        pr = await f.pr(p.pr!.number);
      } catch (err) {
        if ((err as { status?: number }).status !== 404) return n; // host unreachable or failing: settle nothing now
      }
      const at = new Date().toISOString();
      if (!pr || pr.head.ref !== p.branch) Object.assign(p, { status: 'rejected', decidedBy: 'git host', decidedAt: at, comment: 'the pull request no longer exists on the Git host (recreated?); propose again' });
      else if (pr.state === 'closed' && pr.merged) Object.assign(p, { status: 'approved', decidedBy: pr.merged_by?.login ?? 'git host', decidedAt: at, mergedAs: pr.merge_commit_sha });
      else if (pr.state === 'closed') Object.assign(p, { status: 'rejected', decidedBy: 'git host', decidedAt: at, comment: 'the pull request was closed on the Git host' });
      else continue;
      n++;
    }
    if (n) await this.persist();
    return n;
  }

  /** Webhook from the host: merges to main are reconciled; pull requests opened on the host become proposals. */
  async onHostEvent(event: string, body: Record<string, unknown>): Promise<string> {
    const f = this.forge;
    if (!f) return 'no host';
    if (event === 'push' && body.ref === 'refs/heads/main') {
      const r = await this.reconcile('git host');
      return `main → reconcile ${r.ok ? 'ok' : 'failed'}`;
    }
    if (event === 'pull_request') {
      const pr = body.pull_request as PullRequest & { merge_commit_sha?: string; body?: string; user?: { login: string } };
      const action = String(body.action ?? '');
      const sender = (body.sender as { login?: string } | undefined)?.login ?? pr.user?.login ?? 'unknown';
      return this.serial(async () => {
        // the branch carries the unique proposal id; PR numbers restart when the Git host is recreated (reinstall)
        let p = this.meta.proposals.find((x) => x.branch === pr.head.ref) ?? this.meta.proposals.find((x) => x.pr?.number === pr.number && x.status === 'pending');
        if (!p && ['opened', 'reopened', 'synchronized'].includes(action)) {
          // opened by a person on the host: becomes a proposal, validated like the others
          const head = await f.fetch(this.git, pr.head.ref);
          const base = (await this.git.rev('main'))!;
          if (!head) return 'branch not found';
          const id = `cp-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
          p = { id, title: pr.title, reason: String(pr.body ?? '').slice(0, 4000) || pr.title, author: { kind: 'person', id: sender }, createdAt: new Date().toISOString(), base, branch: pr.head.ref, head, paths: await this.git.changedPaths(base, head), status: 'pending', validation: { ok: false, at: '', checks: [] }, owners: [], changeId: randomUUID(), pr: { number: pr.number, url: f.prUrl(pr.number) } };
          await this.validateInto(p, head);
          this.meta.proposals.push(p);
          await f.status(head, p.validation.ok, p.validation.ok ? 'valid' : 'invalid', this.consoleUrl(p.id));
          await this.persist();
          return `proposal ${id} from pull request ${pr.number}`;
        }
        if (!p) return 'unknown pull request';
        if (action === 'synchronized') {
          const head = await f.fetch(this.git, pr.head.ref);
          if (head && head !== p.head) {
            p.head = head;
            p.paths = await this.git.changedPaths(p.base, head);
            await this.validateInto(p, head);
            await f.status(head, p.validation.ok, p.validation.ok ? 'valid' : 'invalid', this.consoleUrl(p.id));
          }
        } else if (action === 'closed') {
          Object.assign(p, pr.merged ? { status: 'approved', decidedBy: pr.merged_by?.login ?? sender, decidedAt: new Date().toISOString(), mergedAs: pr.merge_commit_sha } : { status: 'rejected', decidedBy: sender, decidedAt: new Date().toISOString() });
        }
        await this.persist();
        return `pull request ${pr.number} ${action}`;
      });
    }
    return `ignored ${event}`;
  }

  /** Validation of a revision (proposal head or merge result): layout + schemas, secrets, ontology compile + diff, Rego. */
  private async validateInto(p: Proposal, rev: string) {
    const files = await this.git.files(rev);
    const checks: Check[] = [];
    const parsed = parseState(files);
    checks.push({ name: 'layout and schemas', ok: parsed.errors.length === 0, errors: parsed.errors.length ? parsed.errors : undefined });
    const leaked = findSecrets(files, this.targets.secrets());
    checks.push({ name: 'no secrets', ok: leaked.length === 0, detail: leaked.length ? `secret values in ${leaked.join(', ')}` : undefined });
    const baseFiles = await this.git.files(p.base);
    const classOwners: string[] = [];
    for (const d of domainsOf(p.paths)) {
      const next = ontologyFiles(files, d);
      if (!next) {
        checks.push({ name: `ontology ${d}: compile`, ok: false, detail: 'schema.yaml, actions.yaml and bindings.yaml are required' });
        continue;
      }
      if (!this.validators.compileOntology) {
        checks.push({ name: `ontology ${d}: compile`, ok: false, detail: 'the ontology compiler service is not available' });
        continue;
      }
      const after = await this.validators.compileOntology(next).catch((err: Error) => ({ ok: false, errors: [{ path: 'compiler', message: err.message }] }) as { ok: boolean; ir?: OntologyIr; errors?: Array<{ path: string; message: string }> });
      checks.push({ name: `ontology ${d}: compile`, ok: after.ok, errors: after.errors, detail: after.ir ? `${after.ir.name}@${after.ir.version}, ${after.ir.classes.length} classes, ${after.ir.actions.length} actions` : undefined });
      const prev = ontologyFiles(baseFiles, d);
      const before = prev ? await this.validators.compileOntology(prev).catch(() => undefined) : undefined;
      if (after.ir && before?.ir) {
        p.irDiff = diffIr(before.ir, after.ir);
        p.compat = compatibility(before.ir, after.ir);
        const majors = p.compat.findings.filter((f) => f.level === 'major');
        checks.push({ name: `ontology ${d}: compatibility ${p.compat.level}`, ok: p.compat.level !== 'major' || !!p.migrationNote, detail: p.compat.level === 'major' ? (p.migrationNote ? `breaking, migration note given: ${majors.map((f) => `${f.path} ${f.reason}`).join('; ')}` : `breaking change needs a migration note: ${majors.map((f) => `${f.path} ${f.reason}`).join('; ')}`) : `${p.compat.findings.length} change(s)` });
        checks.push({ name: `ontology ${d}: version`, ok: p.compat.versionOk, detail: p.compat.versionOk ? after.ir.version : `version ${after.ir.version} must be at least ${p.compat.suggestedVersion} for a ${p.compat.level} change` });
        if (this.validators.checkOntology) {
          const r = await this.validators.checkOntology(after.ir).catch((err: Error) => ({ data: { ok: false, findings: [{ path: 'ontology server', problem: err.message, rows: 0 }] } }));
          const blocking = r.data.findings.filter((f) => !/class removed/.test(f.problem));
          checks.push({ name: `ontology ${d}: existing data`, ok: blocking.length === 0, detail: r.data.findings.length ? r.data.findings.map((f) => `${f.path}: ${f.problem} (${f.rows})`).join('; ') : 'existing objects fit the new version' });
        }
        for (const c of Object.keys(p.irDiff.classes)) {
          const owner = (after.ir.classes.find((x) => x.name === c) ?? before.ir.classes.find((x) => x.name === c))?.annotations.owner;
          if (owner) classOwners.push(owner);
        }
      }
    }
    if (p.paths.some((x) => x.startsWith('policies/') && (x.endsWith('.rego') || x.endsWith('.json')))) {
      if (!this.validators.checkRego) checks.push({ name: 'policies: opa check + opa test', ok: false, detail: 'the policy checker is not available' });
      else {
        const rego = Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith('policies/') && (k.endsWith('.rego') || k.endsWith('.json'))).map(([k, v]) => [k.slice('policies/'.length), v]));
        const data = await this.regoData().catch(() => undefined);
        if (data) rego['data.json'] = data;
        const r = await this.validators.checkRego(rego).catch((err: Error) => ({ ok: false, errors: [{ path: 'opa', message: err.message }] }));
        checks.push({ name: 'policies: opa check + opa test', ok: r.ok, errors: r.errors.length ? r.errors : undefined });
      }
    }
    // owners come from main's OWNERS.yaml, never from the proposal itself
    const owners = ownersFile.safeParse(YAML.parse(baseFiles['OWNERS.yaml'] ?? DEFAULT_OWNERS));
    p.owners = owners.success ? requiredOwners(owners.data, p.paths, classOwners) : [{ for: 'OWNERS.yaml invalid', owners: ['role:Platform.Admin'] }];
    p.validation = { ok: checks.every((c) => c.ok), at: new Date().toISOString(), checks };
  }

  /** Validates changes on top of main without creating a proposal (config__validate, the modelling agent). */
  async validateChanges(changes: Array<{ path: string; content: string | null }>, migrationNote?: string) {
    if (!(await this.initialized())) throw new ConfigError(409, 'the config repository is not initialised');
    for (const c of changes) if (!PATH_OK.test(c.path) || c.path.split('/').includes('..') || (!(ROOT_FILES as readonly string[]).includes(c.path) && !MANAGED_PREFIXES.some((x) => c.path.startsWith(x)))) throw new ConfigError(400, `path ${c.path} is outside the config repository layout`);
    return this.serial(async () => {
      const main = (await this.git.rev('main'))!;
      const ref = `refs/liquid/validate-${randomUUID().slice(0, 8)}`;
      const head = await this.git.commit({ ref, parent: main, expect: null, changes: Object.fromEntries(changes.map((c) => [c.path, c.content])), message: 'validate', author: SYSTEM });
      try {
        const probe: Proposal = { id: 'validate', title: 'validate', reason: '-', author: { kind: 'agent', id: 'validate' }, createdAt: '', base: main, branch: ref, head: head ?? main, paths: head ? await this.git.changedPaths(main, head) : [], status: 'pending', validation: { ok: false, at: '', checks: [] }, owners: [], changeId: '-', migrationNote };
        await this.validateInto(probe, head ?? main);
        return { valid: probe.validation.ok, checks: probe.validation.checks, compatibility: probe.compat ?? null, diff: probe.irDiff ? { summary: probe.irDiff.summary, changes: probe.irDiff.changes.map((c) => `${c.kind} ${c.element} ${c.path}`) } : null, approvers: probe.owners };
      } finally {
        await this.git.deleteRef(ref);
      }
    });
  }

  async revalidate(id: string) {
    return this.serial(async () => {
      const p = this.meta.proposals.find((x) => x.id === id);
      if (!p) throw new ConfigError(404, `no proposal ${id}`);
      await this.validateInto(p, p.head);
      if (this.forge && p.pr) await this.forge.status(p.head, p.validation.ok, p.validation.ok ? 'valid' : 'invalid', this.consoleUrl(p.id)).catch(() => undefined);
      await this.persist();
      return p;
    });
  }

  /** Does the core run the ontology of `rev`? (true without the in-force hook) */
  private async ontologyMatches(rev: string): Promise<boolean> {
    if (!this.ontologyInForce) return true;
    const files = await this.git.files(rev, 'ontology/');
    for (const d of domainsOf(Object.keys(files))) {
      const of = ontologyFiles(files, d);
      if (!of) continue;
      const inForce = await this.ontologyInForce(d).catch(() => undefined);
      if (inForce && !Object.entries(of).every(([n, t]) => inForce[n] === sourceHash(t))) return false;
    }
    return true;
  }

  /** Sections of the desired state where the stores differ from main (compared after schema parsing). */
  async drift(): Promise<string[]> {
    const main = await this.git.rev('main');
    return main ? this.driftAt(main) : [];
  }

  private async driftAt(rev: string): Promise<string[]> {
    const want = parseState(await this.git.files(rev)).state;
    const have = parseState(exportState(this.targets.current())).state;
    if (!want || !have) return want ? ['stores'] : [];
    return (Object.keys(want) as Array<keyof DesiredState>).filter((k) => canonical(want[k]) !== canonical(have[k]));
  }
}
