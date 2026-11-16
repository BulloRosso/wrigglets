import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { canonical, diffIr, type IrDiff, type OntologyIr } from '@cw/ontology-ir';
import { GitRepo, type Author } from './git.js';
import { DEFAULT_OWNERS, MANAGED_PREFIXES, README, ROOT_FILES, STORE_FILES, exportState, findSecrets, ownersFile, parseState, requiredOwners, satisfies, type DesiredState } from './layout.js';

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
  private timer?: NodeJS.Timeout;
  /** Called after main changed through a proposal or a reconcile applied something (e.g. to rebuild the OPA bundle). */
  onApplied?: () => void;

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
      return head;
    });
  }

  /** Validate main → apply to the stores → record the applied revision. Runs every 60 s and after each merge. */
  async reconcile(by = 'reconciler', force = false) {
    if (!(await this.initialized())) return { ok: false, skipped: 'repository not initialised' } as const;
    return this.serial(async () => {
      const head = (await this.git.rev('main'))!;
      // applied and the stores still match main (e.g. not reset by an empty /data/admin) → nothing to do
      if (!force && head === this.meta.applied && this.meta.lastReconcile?.ok !== false && (await this.driftAt(head)).length === 0) return { ok: true, head, changes: [] as string[], unchanged: true };
      const files = await this.git.files(head);
      const { state, errors } = parseState(files);
      const leaked = findSecrets(files, this.targets.secrets());
      if (leaked.length) errors.push(...leaked.map((p) => ({ path: p, message: 'contains a secret value' })));
      if (!state || errors.length) {
        this.meta.lastReconcile = { at: new Date().toISOString(), head, ok: false, changes: [], errors };
        await this.persist();
        return { ok: false, head, errors };
      }
      const changes = await this.targets.apply(state, by);
      this.meta.applied = head;
      this.meta.lastReconcile = { at: new Date().toISOString(), head, ok: true, changes, errors: [] };
      await this.persist();
      if (changes.length || force) this.onApplied?.();
      return { ok: true, head, changes };
    });
  }

  start(intervalMs = 60_000, enabled: () => boolean = () => true) {
    const tick = async () => {
      try {
        if (enabled()) await this.reconcile();
      } catch {
        /* recorded in lastReconcile where possible; next tick retries */
      }
      this.timer = setTimeout(() => void tick(), intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(() => void tick(), 5000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
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

  async propose(input: { title: string; reason: string; evidence?: string; changes: Array<{ path: string; content: string | null }>; author: Proposal['author'] }): Promise<Proposal> {
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
      const p: Proposal = { id, title, reason, evidence: input.evidence?.slice(0, 8000), author: input.author, createdAt: new Date().toISOString(), base, branch, head, paths, status: 'pending', validation: { ok: false, at: '', checks: [] }, owners: [], changeId };
      await this.validateInto(p, head);
      this.meta.proposals.push(p);
      await this.persist();
      return p;
    });
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

  async revalidate(id: string) {
    return this.serial(async () => {
      const p = this.meta.proposals.find((x) => x.id === id);
      if (!p) throw new ConfigError(404, `no proposal ${id}`);
      await this.validateInto(p, p.head);
      await this.persist();
      return p;
    });
  }

  /** A person decides. Approve = owners satisfied, not the requester, valid on top of the current main → merge commit. */
  async decide(id: string, decision: 'approve' | 'reject', person: { email: string; roles: string[] }, comment?: string): Promise<Proposal> {
    const out = await this.serial(async () => {
      const p = this.meta.proposals.find((x) => x.id === id);
      if (!p) throw new ConfigError(404, `no proposal ${id}`);
      if (p.status !== 'pending' && p.status !== 'conflict') throw new ConfigError(409, `proposal ${id} is already ${p.status}`);
      const email = person.email.toLowerCase();
      if (decision === 'reject') {
        Object.assign(p, { status: 'rejected', decidedBy: email, decidedAt: new Date().toISOString(), comment });
        await this.persist();
        return p;
      }
      if ((p.author.kind === 'person' && p.author.id.toLowerCase() === email) || p.author.user?.toLowerCase() === email) throw new ConfigError(403, 'four eyes: the requester cannot approve their own proposal');
      const missing = p.owners.filter((s) => !satisfies({ email, roles: person.roles }, s.owners));
      if (missing.length) throw new ConfigError(403, `not an owner of: ${missing.map((m) => `${m.for} (${m.owners.join(', ')})`).join('; ')}`);
      const main = (await this.git.rev('main'))!;
      let tree: string;
      if (main === p.base) tree = await this.git.treeOf(p.head);
      else {
        const m = await this.git.mergeTree(main, p.head);
        if ('conflicts' in m) {
          p.status = 'conflict';
          await this.persist();
          throw new ConfigError(409, `conflicts with the current main: ${m.conflicts.join(', ') || 'see the diff'}`);
        }
        tree = m.tree;
      }
      // validate what main would become
      const probe: Proposal = structuredClone(p);
      const tmpRef = `refs/liquid/probe-${p.id}`;
      const probeCommit = await this.git.commit({ ref: tmpRef, parent: main, expect: await this.git.rev(tmpRef), changes: {}, tree, message: 'probe', author: SYSTEM, extraParents: [p.head] });
      await this.validateInto(probe, probeCommit!);
      await this.git.deleteRef(tmpRef);
      if (!probe.validation.ok) {
        p.validation = probe.validation;
        await this.persist();
        throw new ConfigError(422, `the proposal does not validate on top of the current main: ${probe.validation.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
      }
      const merged = await this.git.commit({
        ref: 'main',
        parent: main,
        changes: {},
        tree,
        extraParents: [p.head],
        message: `${p.title} (proposal ${p.id})\n\n${p.reason}\n\n${trailers({ 'Requested-By': p.author.user ?? (p.author.kind === 'person' ? p.author.id : undefined), Agent: p.author.kind === 'agent' ? p.author.id : undefined, 'Approved-By': email, 'Change-Id': p.changeId })}`,
        author: p.author.kind === 'agent' ? { name: p.author.id, email: `${p.author.id}@agents.local` } : personAuthor(p.author.id),
        committer: personAuthor(email),
      });
      Object.assign(p, { status: 'approved', decidedBy: email, decidedAt: new Date().toISOString(), comment, mergedAs: merged ?? main });
      await this.persist();
      return p;
    });
    if (out.status === 'approved') await this.reconcile(out.decidedBy ?? 'reconciler');
    return out;
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
