/*
 * Health of the Liquid control loop in one place (ADR-0051). Every part that runs on its own — services, policy
 * distribution, the core's dispatcher and lake flush, reconciler, Git host, event feed — and every state a person
 * left in force — holds, overlays, kill switch, pending decisions, expiring apps — becomes one item with a status
 * and a hint what to do. Read-only; each probe has its own timeout and failure, so one broken part never hides the
 * others.
 */

export type HealthStatus = 'ok' | 'warn' | 'fail';

export interface HealthItem {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  hint?: string;
  /** Console path that shows or fixes it. */
  link?: string;
}

export interface LiquidHealth {
  status: HealthStatus;
  checkedAt: string;
  items: HealthItem[];
}

type Maybe<T> = Promise<T>;

export interface HealthDeps {
  now?: () => number;
  services(): Maybe<Array<{ name: string; state: string; health?: string | null }>>;
  policy(): Maybe<{ bundle: { revision: string } | null; compileError: string | null; consumers: Record<string, { at: string; revision: string }>; overlays: Array<{ id: string; effect: string; source?: string }> }>;
  core(): Maybe<{ events: { maxSeq: number }; dispatcher: { cursor: number; updatedAt: string; lag: number } | null; lake: { hwm: number | null; lag: number | null; lastFlush: unknown; error: string | null }; policy: { revision: string; loadedAt: string } | null; ontology: { name: string; version: string } }>;
  config(): Maybe<{ initialized: boolean; inSync: boolean; lastReconcile: { at: string; ok: boolean; errors: Array<{ path: string; message: string }> } | null; lastRunAt?: string | null; pendingProposals: number }>;
  gitHost?(): Maybe<{ ready: boolean; setUp: boolean; overlay?: boolean; stats: { okAt?: string; errorAt?: string; error?: string; retries: number } }>;
  eventFeed(): { at: string; forwarded: number; error?: string } | undefined;
  inbox(): Maybe<Array<{ kind: string; createdAt: string; decideHere: boolean }>>;
  held(): Maybe<Array<{ workflowId: string; refs: string[] }>>;
  killSwitch(): { level: string; reason?: string };
  playbookRuns(): Maybe<Array<{ runId: string; state: string }>>;
  apps(): Array<{ id: string; status: string; expiresAt: string; statusNote?: string }>;
}

const MIN = 60_000;
const ago = (iso: string | undefined, now: number) => (iso ? Math.round((now - Date.parse(iso)) / 1000) : Infinity);
const fmt = (s: number) => (s === Infinity ? 'never' : s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);

async function probe(id: string, label: string, fn: () => Promise<Omit<HealthItem, 'id' | 'label'>>): Promise<HealthItem> {
  try {
    const r = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no answer within 10 s')), 10_000).unref?.())]);
    return { id, label, ...r };
  } catch (err) {
    return { id, label, status: 'fail', detail: (err as Error).message.slice(0, 300), hint: 'the probe itself failed: check the service and its logs' };
  }
}

export async function liquidHealth(d: HealthDeps): Promise<LiquidHealth> {
  const now = d.now?.() ?? Date.now();
  const items = await Promise.all([
    probe('services', 'Services', async () => {
      const s = await d.services();
      const bad = s.filter((x) => x.state !== 'running' || (x.health && x.health !== 'healthy'));
      return bad.length
        ? { status: 'fail', detail: bad.map((x) => `${x.name}: ${x.health ?? x.state}`).join(', '), hint: 'Extensions → Repair re-creates and starts them', link: '/extensions' }
        : { status: 'ok', detail: `${s.length} running: ${s.map((x) => x.name).join(', ')}` };
    }),
    probe('policy', 'Policy distribution', async () => {
      const p = await d.policy();
      if (p.compileError) return { status: 'fail', detail: `the policies do not compile: ${p.compileError.slice(0, 200)}`, hint: 'the last good package stays in force; fix policies/liquid/ through a proposal', link: '/liquid/policies' };
      const rev = p.bundle?.revision;
      if (!rev) return { status: 'fail', detail: 'no policy package built yet: both enforcement points deny everything (fail closed)', link: '/liquid/policies' };
      const lagging = ['gateway', 'core'].filter((c) => p.consumers[c]?.revision !== rev || ago(p.consumers[c]?.at, now) > 60);
      return lagging.length
        ? { status: 'warn', detail: `${lagging.map((c) => `${c} ${p.consumers[c] ? `on ${p.consumers[c]!.revision.slice(0, 8)}, fetched ${fmt(ago(p.consumers[c]!.at, now))}` : 'never fetched'}`).join('; ')} (current ${rev.slice(0, 8)})`, hint: 'a consumer that cannot fetch keeps its last package; one without any denies everything', link: '/liquid/policies' }
        : { status: 'ok', detail: `gateway and core on ${rev.slice(0, 8)}` };
    }),
    probe('core', 'Enterprise core: dispatcher and lake', async () => {
      const c = await d.core();
      const problems: string[] = [];
      let status: HealthStatus = 'ok';
      if (!c.dispatcher) {
        status = 'warn';
        problems.push('the dispatcher has no position yet');
      } else if (c.dispatcher.lag > 0 && ago(c.dispatcher.updatedAt, now) > 2 * 60) {
        status = 'fail';
        problems.push(`dispatcher ${c.dispatcher.lag} events behind, last progress ${fmt(ago(c.dispatcher.updatedAt, now))}`);
      }
      if (c.lake.error) {
        status = status === 'fail' ? 'fail' : 'warn';
        problems.push(`lake: ${c.lake.error}`);
      } else if ((c.lake.lag ?? 0) > 1000) {
        status = status === 'fail' ? 'fail' : 'warn';
        problems.push(`${c.lake.lag} events not yet in the lake`);
      }
      if (!c.policy) {
        status = 'fail';
        problems.push('no policy package loaded: every action is denied');
      }
      return problems.length
        ? { status, detail: problems.join('; '), hint: 'logs: docker logs cw-ext-liquid-ontology-server', link: '/liquid/processes' }
        : { status: 'ok', detail: `ontology ${c.ontology.name}@${c.ontology.version}; ${c.events.maxSeq} events; dispatcher ${c.dispatcher!.lag} behind; lake ${c.lake.lag ?? '?'} behind` };
    }),
    probe('reconcile', 'Config reconciler', async () => {
      const c = await d.config();
      if (!c.initialized) return { status: 'warn', detail: 'the config repository is not initialised yet', link: '/liquid/proposals' };
      const r = c.lastReconcile;
      if (!r) return { status: 'warn', detail: 'no reconcile run yet', link: '/liquid/proposals' };
      if (!r.ok) return { status: 'fail', detail: `last run failed ${fmt(ago(r.at, now))}: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 250)}`, hint: 'main is not applied; the stores keep the last applied revision', link: '/liquid/proposals' };
      const last = c.lastRunAt && c.lastRunAt > r.at ? c.lastRunAt : r.at; // runs with nothing to do count too
      if (ago(last, now) > 3 * 60) return { status: 'warn', detail: `last run ${fmt(ago(last, now))} (expected every minute)`, hint: 'Proposals → Reconcile now', link: '/liquid/proposals' };
      return { status: c.inSync ? 'ok' : 'warn', detail: `${c.inSync ? 'main applied' : 'main not applied yet'}, last run ${fmt(ago(last, now))}, last change applied ${fmt(ago(r.at, now))}; ${c.pendingProposals} proposal(s) pending` };
    }),
    probe('git-host', 'Git host (Forgejo)', async () => {
      if (!d.gitHost) return { status: 'ok', detail: 'not used (overlay mode: review in the console)' };
      const g = await d.gitHost();
      if (!g.setUp && g.overlay) return { status: 'ok', detail: 'not used: overlay mode reviews proposals in the console' };
      if (!g.setUp) return { status: 'warn', detail: 'not set up yet: proposals are reviewed in the console until the bootstrap ran', hint: 'Extensions → Repair runs the bootstrap', link: '/extensions' };
      if (!g.ready) return { status: 'fail', detail: 'not reachable: no new proposals or merges; main keeps being applied', hint: 'Extensions → Repair; docker logs cw-ext-liquid-forgejo', link: '/extensions' };
      const recentError = g.stats.errorAt && (!g.stats.okAt || g.stats.errorAt > g.stats.okAt) && ago(g.stats.errorAt, now) < 10 * 60;
      return recentError ? { status: 'warn', detail: `last call failed ${fmt(ago(g.stats.errorAt, now))}: ${g.stats.error}`, link: '/liquid/proposals' } : { status: 'ok', detail: `reachable; ${g.stats.retries} retried call(s) since start` };
    }),
    probe('event-feed', 'Audit into the event log', async () => {
      const f = d.eventFeed();
      if (!f) return { status: 'warn', detail: 'no forwarding run yet' };
      if (f.error) return { status: 'fail', detail: `last run failed ${fmt(ago(f.at, now))}: ${f.error.slice(0, 200)}`, hint: 'admin, gateway and agent audit stay in their local files and are forwarded later', link: '/liquid/events' };
      return ago(f.at, now) > 2 * 60 ? { status: 'warn', detail: `last run ${fmt(ago(f.at, now))}` } : { status: 'ok', detail: `last run ${fmt(ago(f.at, now))}, ${f.forwarded} forwarded` };
    }),
    probe('decisions', 'Decisions waiting for a person', async () => {
      const inbox = await d.inbox();
      const runs = (await d.playbookRuns()).filter((r) => r.state === 'awaiting_approval');
      if (!inbox.length) return { status: 'ok', detail: 'nothing pending' };
      const oldest = Math.max(...inbox.map((i) => ago(i.createdAt, now)));
      const kinds = Object.entries(inbox.reduce<Record<string, number>>((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(', ');
      return { status: oldest > 3 * 86_400 || runs.length ? 'warn' : 'ok', detail: `${inbox.length} pending (${kinds}); oldest ${fmt(oldest)}${runs.length ? `; ${runs.length} playbook run(s) wait for a person` : ''}`, link: '/liquid/approvals' };
    }),
    probe('tightening', 'Tightening in force', async () => {
      const p = await d.policy();
      const held = await d.held();
      const ks = d.killSwitch();
      const parts: string[] = [];
      if (ks.level !== 'normal') parts.push(`kill switch ${ks.level}${ks.reason ? ` (${ks.reason})` : ''}`);
      if (p.overlays.length) parts.push(`${p.overlays.length} overlay(s): ${p.overlays.map((o) => `${o.effect}${o.source ? ` from ${o.source}` : ''}`).join(', ').slice(0, 160)}`);
      if (held.length) parts.push(`${held.length} business workflow(s) held (${[...new Set(held.flatMap((h) => h.refs))].join(', ').slice(0, 120)})`);
      return parts.length ? { status: 'warn', detail: parts.join('; '), hint: 'intended while an incident is handled; loosening is a person’s decision', link: '/liquid/playbooks' } : { status: 'ok', detail: 'no overlay, no hold, kill switch normal' };
    }),
    probe('apps', 'Apps', async () => {
      const apps = d.apps();
      const soon = apps.filter((a) => a.status === 'active' && Date.parse(a.expiresAt) - now < 14 * 86_400_000);
      // a rejected registration is the owner's to fix; a formerly active app that failed a re-check is a problem
      const failed = apps.filter((a) => a.status === 'rejected' && !!a.statusNote);
      const active = apps.filter((a) => a.status === 'active').length;
      if (!apps.length) return { status: 'ok', detail: 'none registered' };
      return soon.length || failed.length
        ? { status: 'warn', detail: [`${active} active`, soon.length ? `${soon.length} expire within 14 days (${soon.map((a) => a.id).join(', ')})` : '', failed.length ? `${failed.length} failed a re-check and lost sign-in (${failed.map((a) => a.id).join(', ')})` : ''].filter(Boolean).join('; '), hint: 'the owner registers a new version (new SDK) or extends it', link: '/liquid/apps' }
        : { status: 'ok', detail: `${active} active, ${apps.length} registered` };
    }),
  ]);
  const status: HealthStatus = items.some((i) => i.status === 'fail') ? 'fail' : items.some((i) => i.status === 'warn') ? 'warn' : 'ok';
  return { status, checkedAt: new Date(now).toISOString(), items };
}
