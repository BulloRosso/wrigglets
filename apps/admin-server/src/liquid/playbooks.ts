import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import type { Client } from '@temporalio/client';
import { BUSINESS_TASK_QUEUE, cancelRunSignal, decideUpdate, playbookRunQuery, stepApprovalId, type PlaybookRunState, type StepResult } from '@cw/business-workflows';
import { blastRadius, checkStep, directionOf, durationMs, matching, validatePlaybook, type BlastRadius, type Playbook, type SensedEvent } from '@cw/playbooks';
import type { KillLevel, UpstreamServer } from '@cw/shared';
import type { Overlay, OverlayInput } from '../extensions/liquidPolicy.js';

/*
 * Playbooks, control-plane side (ADR-0047): one sensing path — alerts, safety-metric trips, schedule ticks and event-log
 * events all become SensedEvents, are recorded in the event log, and start the PlaybookRun of every matching playbook
 * (playbooks come from the applied revision of the config repository). The run (business worker) calls back here to
 * assess the blast radius and to execute steps; every executed step is an event. Tightening steps return undo data;
 * restore reverts them. Config-affecting steps are committed to the config repository so the reconciler keeps them.
 */

export interface PlaybookDeps {
  client: () => Client | undefined;
  /** playbooks/*.yaml of the applied config revision. */
  files: () => Promise<Record<string, string> | undefined>;
  ontologyIr: () => Promise<{ actions: Array<{ name: string; target?: string; readOnly: boolean; input: Array<{ name: string; range: string; rangeKind: string }> }> }>;
  gatewayTools: () => Promise<string[]>;
  runningWorkflows: () => Promise<Array<{ workflowId: string; objects: string[] }>>;
  /** Appends events to the event log (ontology server /internal/events). */
  events: (events: Array<{ type: string; objectType: string; objectId: string; payload: Record<string, unknown>; actorAgent?: string; actorUser?: string; workflowId?: string }>) => Promise<void>;
  gateway: { upstreams: UpstreamServer[]; setUpstream(u: UpstreamServer): Promise<void>; allowedTools(agentId: string): string[]; setAllowedTools(agentId: string, patterns: string[]): Promise<void> };
  overlays: { listOverlays(): Overlay[]; addOverlay(o: OverlayInput, by: string): Promise<Overlay>; removeOverlay(id: string): Promise<Overlay | undefined> };
  processes: { hold(objects: string[], reason: string, ref: string): Promise<{ workflows: string[] }>; release(ref: string): Promise<{ workflows: string[] }> };
  killSwitch: { effective(agentId: string): { level: KillLevel }; get(): { global: { level: KillLevel } }; setAgent(agentId: string, level: KillLevel, reason: string | undefined, by: string): Promise<void>; setGlobal(level: KillLevel, reason: string | undefined, by: string): Promise<void> };
  /** Records store changes in the config repository (author = the playbook run). */
  capture: (by: string, what: string) => Promise<unknown>;
  /** Marks a store change whose capture is still to come, so a reconcile meanwhile does not revert it (ADR-0046). */
  editing?: <T>(fn: () => Promise<T>) => Promise<T>;
  propose: (p: { title: string; reason: string; changes: Array<{ path: string; content: string | null }>; author: string }) => Promise<{ id: string; valid: boolean }>;
  shadowReplay: (body: { windowMs: number; candidate?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  audit?: { write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void> };
}

export interface StepRequest {
  runId: string;
  playbook: string;
  step: { id: string; type: string; autonomy: string };
  with: Record<string, unknown>;
  approvedBy?: string;
  prior: StepResult[];
}
export interface StepOutcome {
  ok: boolean;
  summary: string;
  undo?: Record<string, unknown>;
  data?: Record<string, unknown>;
  proposed?: boolean;
}

export class PlaybookError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RANK: Record<KillLevel, number> = { normal: 0, paused: 1, tools_off: 2, stopped: 3 };

export class PlaybookService {
  private lastTick = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly d: PlaybookDeps) {}

  private c(): Client {
    const c = this.d.client();
    if (!c) throw new PlaybookError(503, 'Temporal is not connected');
    return c;
  }

  /** Valid playbooks of the applied config revision, and the invalid ones with their problems. */
  async load(): Promise<{ playbooks: Playbook[]; invalid: Array<{ path: string; issues: Array<{ path: string; message: string }> }>; sources: Record<string, string> }> {
    const files = (await this.d.files().catch(() => undefined)) ?? {};
    const playbooks: Playbook[] = [];
    const invalid: Array<{ path: string; issues: Array<{ path: string; message: string }> }> = [];
    const sources: Record<string, string> = {};
    for (const [p, text] of Object.entries(files)) {
      if (!/\.ya?ml$/.test(p)) continue;
      let doc: unknown;
      try {
        doc = YAML.parse(text);
      } catch (err) {
        invalid.push({ path: p, issues: [{ path: '(yaml)', message: (err as Error).message.split('\n')[0]! }] });
        continue;
      }
      const r = validatePlaybook(doc);
      if (r.playbook) {
        playbooks.push(r.playbook);
        sources[r.playbook.id] = p;
      } else invalid.push({ path: p, issues: r.issues });
    }
    return { playbooks: playbooks.sort((a, b) => a.id.localeCompare(b.id)), invalid, sources };
  }

  /** One sensing path: record the event, start a run for every matching playbook. */
  async sense(e: SensedEvent, by: string): Promise<{ eventType: string; runs: Array<{ runId: string; playbook: string; workflowId: string }> }> {
    const eventType = e.kind === 'alert' ? 'AlertReceived' : e.kind === 'safety_metric' ? 'SafetyRuleTripped' : e.kind === 'schedule' ? 'ScheduleTick' : e.kind === 'signal' ? 'SignalObserved' : (e.type ?? 'Event');
    if (e.kind !== 'event') await this.d.events([{ type: eventType, objectType: 'Sensor', objectId: String(e.data.source ?? e.data.rule ?? e.playbook ?? e.kind), payload: { ...e.data, kind: e.kind } }]);
    const { playbooks } = await this.load();
    const runs: Array<{ runId: string; playbook: string; workflowId: string }> = [];
    for (const p of matching(playbooks, e)) {
      const runId = `pr-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
      const workflowId = `PlaybookRun-${runId}`;
      await this.c().workflow.start('PlaybookRun', { taskQueue: BUSINESS_TASK_QUEUE, workflowId, args: [{ runId, playbook: p, trigger: { kind: e.kind, data: e.data }, startedBy: by }] });
      await this.d.events([{ type: 'PlaybookRunStarted', objectType: 'PlaybookRun', objectId: runId, workflowId, payload: { playbook: p.id, version: p.version, trigger: { kind: e.kind, ...e.data }, startedBy: by } }]);
      runs.push({ runId, playbook: p.id, workflowId });
    }
    return { eventType, runs };
  }

  /** Schedule triggers: a tick per playbook when its interval has passed (checked every minute). */
  start(enabled: () => boolean) {
    const tick = async () => {
      try {
        if (enabled()) {
          const { playbooks } = await this.load();
          for (const p of playbooks) {
            if (p.trigger.kind !== 'schedule') continue;
            const last = this.lastTick.get(p.id) ?? Date.now();
            if (!this.lastTick.has(p.id)) this.lastTick.set(p.id, last);
            else if (Date.now() - last >= durationMs(p.trigger.every)) {
              this.lastTick.set(p.id, Date.now());
              await this.sense({ kind: 'schedule', playbook: p.id, data: { playbook: p.id, every: p.trigger.every } }, 'schedule');
            }
          }
        }
      } catch {
        /* next tick */
      }
      this.timer = setTimeout(() => void tick(), 60_000);
      this.timer.unref?.();
    };
    this.timer = setTimeout(() => void tick(), 15_000);
    this.timer.unref?.();
  }

  async assess(trigger: Record<string, unknown>): Promise<BlastRadius | null> {
    const upstream = typeof trigger.upstream === 'string' ? trigger.upstream : undefined;
    if (!upstream) return null;
    const [ir, tools, workflows] = await Promise.all([this.d.ontologyIr(), this.d.gatewayTools(), this.d.runningWorkflows()]);
    // a disabled upstream lists no tools at the gateway: use the names it had (tool name = <upstream>__<action>)
    const known = tools.some((t) => t.startsWith(`${upstream}__`)) ? tools : ir.actions.map((a) => `${upstream}__${a.name}`);
    return blastRadius({ upstream, tools: known, actions: ir.actions, workflows: workflows.filter((w) => !w.workflowId.startsWith('PlaybookRun-')) });
  }

  /** Executes one step for a run (called by the business worker). Refuses loosening without a person. */
  async execute(r: StepRequest): Promise<StepOutcome> {
    const check = checkStep({ type: r.step.type, autonomy: r.step.autonomy as never }, r.with, r.approvedBy);
    const by = `playbook:${r.playbook}/${r.runId}`;
    let out: StepOutcome;
    if (!check.ok) out = { ok: false, summary: check.error };
    else {
      try {
        out = this.d.editing ? await this.d.editing(() => this.run(r, check.with, by)) : await this.run(r, check.with, by);
      } catch (err) {
        out = { ok: false, summary: (err as Error).message };
      }
    }
    await this.d.events([{ type: 'PlaybookStepExecuted', objectType: 'PlaybookRun', objectId: r.runId, actorUser: r.approvedBy, payload: { playbook: r.playbook, step: r.step.id, type: r.step.type, autonomy: r.step.autonomy, direction: directionOf(r.step.type) ?? null, ok: out.ok, summary: out.summary, approvedBy: r.approvedBy ?? null, undo: out.undo ?? null } }]);
    await this.d.audit?.write({ by: r.approvedBy ?? by, action: `playbook.step.${r.step.type}`, target: r.runId, details: { step: r.step.id, ok: out.ok, summary: out.summary } });
    return out;
  }

  private async run(r: StepRequest, w: Record<string, unknown>, by: string): Promise<StepOutcome> {
    const what = `${r.playbook} ${r.step.id} (${r.step.type})`;
    switch (r.step.type) {
      case 'gateway.upstream.disable': {
        const u = this.d.gateway.upstreams.find((x) => x.name === w.upstream);
        if (!u) return { ok: false, summary: `unknown upstream ${String(w.upstream)}` };
        if (u.enabled) {
          await this.d.gateway.setUpstream({ ...u, enabled: false });
          await this.d.capture(by, what);
        }
        return { ok: true, summary: u.enabled ? `upstream ${u.name} disabled` : `upstream ${u.name} was already disabled`, undo: { kind: 'upstream', upstream: u.name, wasEnabled: u.enabled } };
      }
      case 'policy.overlay.add': {
        const actions = [...new Set([...((w.actions as string[] | undefined) ?? [])])];
        const classes = (w.classes as string[] | undefined) ?? (w.actions_on as string[] | undefined);
        const match = Object.fromEntries(Object.entries({ actions: actions.length ? actions : undefined, classes: classes?.length ? classes : undefined, upstreams: (w.upstreams as string[] | undefined)?.length ? w.upstreams : undefined }).filter(([, v]) => v !== undefined));
        if (!Object.keys(match).length) return { ok: true, summary: 'nothing to restrict (empty blast radius)' };
        const o = await this.d.overlays.addOverlay({ effect: w.obligation as OverlayInput['effect'], reason: String(w.reason ?? `playbook ${r.playbook}`).slice(0, 300), match: match as OverlayInput['match'], source: `playbook:${r.playbook}/${r.runId}` }, by);
        await this.d.capture(by, what);
        return { ok: true, summary: `overlay ${o.id}: ${o.effect} on ${Object.entries(match).map(([k, v]) => `${k} ${(v as string[]).length}`).join(', ')}`, undo: { kind: 'overlay', id: o.id } };
      }
      case 'temporal.hold': {
        const objects = w.objects as string[];
        if (!objects.length) return { ok: true, summary: 'no running workflow touches the blast radius', undo: { kind: 'hold', ref: w.ref } };
        const h = await this.d.processes.hold(objects, String(w.reason ?? `playbook ${r.playbook}`), String(w.ref));
        return { ok: true, summary: `${h.workflows.length} workflow(s) held`, undo: { kind: 'hold', ref: w.ref }, data: { workflows: h.workflows } };
      }
      case 'killswitch.raise': {
        const level = w.level as KillLevel;
        const agent = w.agent as string | undefined;
        const before = agent ? this.d.killSwitch.effective(agent).level : this.d.killSwitch.get().global.level;
        if (RANK[before] >= RANK[level]) return { ok: true, summary: `kill switch already at ${before}` };
        if (agent) await this.d.killSwitch.setAgent(agent, level, String(w.reason ?? `playbook ${r.playbook}`), by);
        else await this.d.killSwitch.setGlobal(level, String(w.reason ?? `playbook ${r.playbook}`), by);
        return { ok: true, summary: `kill switch ${agent ?? 'global'}: ${before} → ${level}`, undo: { kind: 'killswitch', agent: agent ?? null, level: before } };
      }
      case 'entra.revoke_scope': {
        // local stand-in for removing the app role / scope in Entra (M9): the agent's tools of that upstream go away
        const agent = String(w.agent);
        const before = this.d.gateway.allowedTools(agent);
        const after = before.filter((p) => !p.startsWith(`${String(w.upstream)}__`));
        if (after.length !== before.length) {
          await this.d.gateway.setAllowedTools(agent, after);
          await this.d.capture(by, what);
        }
        return { ok: true, summary: `${before.length - after.length} pattern(s) of ${String(w.upstream)} removed from ${agent} (local stand-in for Entra)`, undo: { kind: 'allowlist', agent, patterns: before } };
      }
      case 'notify':
        await this.d.events([{ type: 'BusinessNotification', objectType: 'Notification', objectId: r.runId, payload: { kind: 'playbook', subject: w.subject, body: w.body ?? '' } }]);
        return { ok: true, summary: `notified: ${String(w.subject)}` };
      case 'shadow.replay': {
        const report = await this.d.shadowReplay({ windowMs: durationMs(String(w.window)), candidate: w.candidate as Record<string, unknown> | undefined });
        return { ok: true, summary: `replayed ${String(report.events)} events: ${String(report.blocked ?? 0)} action(s) would need approval or be blocked, ${String(report.diverged ?? 0)} diverged`, data: { report } };
      }
      case 'agent.task':
        await this.d.events([{ type: 'AgentTaskRequested', objectType: 'Agent', objectId: String(w.agent), payload: { playbook: r.playbook, run: r.runId, prompt: w.prompt ?? '', approval: w.approval } }]);
        return { ok: true, proposed: true, summary: `task for ${String(w.agent)} requested (plan approval: ${String(w.approval)}); a person starts it`, data: { agent: w.agent, prompt: w.prompt } };
      case 'config.propose': {
        const p = await this.d.propose({ title: String(w.title), reason: String(w.reason), changes: w.changes as Array<{ path: string; content: string | null }>, author: `playbook-${r.playbook}` });
        return { ok: true, proposed: true, summary: `config proposal ${p.id} (${p.valid ? 'valid' : 'invalid'})`, data: { proposal: p.id } };
      }
      case 'restore':
        return this.restore(r, by);
      case 'policy.overlay.remove': {
        const list = this.d.overlays.listOverlays().filter((o) => (w.id && o.id === w.id) || (w.source && o.source === w.source));
        for (const o of list) await this.d.overlays.removeOverlay(o.id);
        if (list.length) await this.d.capture(r.approvedBy ?? by, what);
        return { ok: true, summary: `${list.length} overlay(s) removed` };
      }
      case 'temporal.release': {
        const rel = await this.d.processes.release(String(w.ref));
        return { ok: true, summary: `${rel.workflows.length} workflow(s) released` };
      }
      case 'gateway.upstream.enable': {
        const u = this.d.gateway.upstreams.find((x) => x.name === w.upstream);
        if (!u) return { ok: false, summary: `unknown upstream ${String(w.upstream)}` };
        await this.d.gateway.setUpstream({ ...u, enabled: true });
        await this.d.capture(r.approvedBy ?? by, what);
        return { ok: true, summary: `upstream ${u.name} enabled` };
      }
      case 'killswitch.lower': {
        const agent = w.agent as string | undefined;
        if (agent) await this.d.killSwitch.setAgent(agent, w.level as KillLevel, `restored by ${r.approvedBy}`, r.approvedBy ?? by);
        else await this.d.killSwitch.setGlobal(w.level as KillLevel, `restored by ${r.approvedBy}`, r.approvedBy ?? by);
        return { ok: true, summary: `kill switch ${agent ?? 'global'} → ${String(w.level)}` };
      }
      default:
        return { ok: false, summary: `no executor for ${r.step.type}` };
    }
  }

  /** Reverts the tightening steps of this run, newest first (only with a person's approval — checked before). */
  private async restore(r: StepRequest, by: string): Promise<StepOutcome> {
    const done: string[] = [];
    let config = false;
    for (const st of [...r.prior].reverse()) {
      const u = st.undo as Record<string, unknown> | undefined;
      if (!u || st.state !== 'done') continue;
      if (u.kind === 'upstream' && u.wasEnabled) {
        const up = this.d.gateway.upstreams.find((x) => x.name === u.upstream);
        if (up && !up.enabled) {
          await this.d.gateway.setUpstream({ ...up, enabled: true });
          config = true;
          done.push(`upstream ${String(u.upstream)} enabled`);
        }
      } else if (u.kind === 'overlay') {
        if (await this.d.overlays.removeOverlay(String(u.id))) {
          config = true;
          done.push(`overlay ${String(u.id)} removed`);
        }
      } else if (u.kind === 'hold') {
        const rel = await this.d.processes.release(String(u.ref));
        done.push(`${rel.workflows.length} workflow(s) released`);
      } else if (u.kind === 'killswitch') {
        if (u.agent) await this.d.killSwitch.setAgent(String(u.agent), u.level as KillLevel, `restored by ${r.approvedBy}`, r.approvedBy ?? by);
        else await this.d.killSwitch.setGlobal(u.level as KillLevel, `restored by ${r.approvedBy}`, r.approvedBy ?? by);
        done.push(`kill switch ${String(u.agent ?? 'global')} → ${String(u.level)}`);
      } else if (u.kind === 'allowlist') {
        await this.d.gateway.setAllowedTools(String(u.agent), u.patterns as string[]);
        config = true;
        done.push(`allow-list of ${String(u.agent)} restored`);
      }
    }
    if (config) await this.d.capture(r.approvedBy ?? by, `${r.playbook} restore (approved by ${r.approvedBy})`);
    return { ok: true, summary: done.length ? done.join('; ') : 'nothing to restore' };
  }

  async record(i: { runId: string; playbook: string; type: string; data: Record<string, unknown> }) {
    const events: Parameters<PlaybookDeps['events']>[0] = [{ type: i.type, objectType: 'PlaybookRun', objectId: i.runId, payload: { playbook: i.playbook, ...i.data } }];
    if (i.type === 'PlaybookRunFinished' && i.data.recordIncident) events.push({ type: 'IncidentRecorded', objectType: 'Incident', objectId: i.runId, payload: { playbook: i.playbook, state: i.data.state, steps: i.data.steps } });
    await this.d.events(events);
  }

  /* -------------------------------------------------------------------------------- runs for the console */

  async runs(limit = 50): Promise<PlaybookRunState[]> {
    const out: PlaybookRunState[] = [];
    for await (const w of this.c().workflow.list({ query: "WorkflowType = 'PlaybookRun'", pageSize: limit })) {
      const s = await this.c()
        .workflow.getHandle(w.workflowId)
        .query(playbookRunQuery)
        .catch(() => undefined);
      if (s) out.push({ ...s, ...({ startTime: w.startTime.toISOString(), closeTime: w.closeTime?.toISOString() ?? null, workflowId: w.workflowId } as object) } as PlaybookRunState);
      if (out.length >= limit) break;
    }
    return out;
  }

  async decide(runId: string, stepId: string, decision: 'approve' | 'reject', by: string, comment?: string) {
    try {
      // a human step is an ApprovalWorkflow (the one approval mechanism, ADR-0049)
      return await this.c().workflow.getHandle(stepApprovalId(runId, stepId)).executeUpdate(decideUpdate, { args: [{ decision, by, comment }] });
    } catch (err) {
      const e = err as Error & { cause?: Error };
      throw new PlaybookError(409, e.cause?.message ?? e.message);
    }
  }

  async cancel(runId: string, by: string, reason?: string) {
    await this.c().workflow.getHandle(`PlaybookRun-${runId}`).signal(cancelRunSignal, { by, reason });
  }
}
