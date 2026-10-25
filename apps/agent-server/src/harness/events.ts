import { EventEmitter } from 'node:events';
import path from 'node:path';
import { LIVE_EVENT_MAX_TEXT, type LiveEvent } from '@cw/shared';
import { logger } from '../logger.js';
import { safetyStats } from '../safetyStats.js';
import type { HarnessClient, HarnessEvent } from './client.js';

/*
 * One long-lived subscription to the harness event stream per process, fanned out in-process
 * (spec §6.4):
 *   - per session (raw events)       → runAgentStep heartbeats
 *   - per task (sanitized LiveEvent) → SSE endpoint /api/tasks/:id/live
 */

interface ActiveStep {
  taskId: string;
  stepId: string;
  kind: string;
}

const tail = (s: string) => (s.length > LIVE_EVENT_MAX_TEXT ? { text: s.slice(-LIVE_EVENT_MAX_TEXT), truncated: true } : { text: s, truncated: false });

export class HarnessEventBus {
  private readonly emitter = new EventEmitter();
  private readonly sessions = new Map<string, ActiveStep>();
  private readonly roles = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly recent = new Map<string, LiveEvent[]>();
  private abort?: AbortController;
  /** Sessions in which a permission request was observed (must never happen with our config). */
  readonly permissionViolations = new Set<string>();

  constructor(
    private readonly harness: HarnessClient,
    private readonly workspaceDir: string,
  ) {
    this.emitter.setMaxListeners(200);
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.abort?.abort();
  }

  private async loop() {
    let backoff = 1000;
    for (;;) {
      this.abort = new AbortController();
      try {
        for await (const ev of this.harness.events(this.abort.signal)) {
          backoff = 1000;
          this.handle(ev);
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        logger.debug({ err: String(err) }, 'harness event stream interrupted');
      }
      if (this.abort.signal.aborted) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  /* ------------------------------------------------------------ registration by runAgentStep */

  beginStep(sessionId: string, step: ActiveStep) {
    this.sessions.set(sessionId, step);
    this.publish(step.taskId, { type: 'step', at: new Date().toISOString(), stepId: step.stepId, kind: step.kind, phase: 'started' });
  }

  endStep(sessionId: string) {
    const step = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (step) {
      this.publish(step.taskId, { type: 'step', at: new Date().toISOString(), stepId: step.stepId, kind: step.kind, phase: 'finished' });
      this.publish(step.taskId, { type: 'idle', at: new Date().toISOString() });
    }
  }

  isTaskActive(taskId: string): boolean {
    return [...this.sessions.values()].some((s) => s.taskId === taskId);
  }

  /* ------------------------------------------------------------ subscriptions */

  onSession(sessionId: string, fn: (ev: HarnessEvent) => void): () => void {
    this.emitter.on(`session:${sessionId}`, fn);
    return () => this.emitter.off(`session:${sessionId}`, fn);
  }

  onTask(taskId: string, fn: (ev: LiveEvent) => void): () => void {
    this.emitter.on(`task:${taskId}`, fn);
    return () => this.emitter.off(`task:${taskId}`, fn);
  }

  recentEvents(taskId: string): LiveEvent[] {
    return this.recent.get(taskId) ?? [];
  }

  private publish(taskId: string, ev: LiveEvent) {
    const buf = this.recent.get(taskId) ?? [];
    buf.push(ev);
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    this.recent.set(taskId, buf);
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value!);
    this.emitter.emit(`task:${taskId}`, ev);
  }

  /* ------------------------------------------------------------ mapping */

  private handle(ev: HarnessEvent) {
    const props = (ev as { properties?: Record<string, unknown> }).properties ?? {};
    const sessionId = (props.sessionID as string | undefined) ?? ((props.part as { sessionID?: string } | undefined)?.sessionID);

    if (ev.type === 'permission.asked') {
      const p = ev.properties;
      logger.error({ sessionId: p.sessionID, permission: p.permission }, 'harness asked for a permission — rejecting');
      this.permissionViolations.add(p.sessionID);
      safetyStats.recordPermissionViolation();
      void this.harness.rejectPermission(p.id).catch(() => undefined);
      void this.harness.abort(p.sessionID).catch(() => undefined);
    }
    if (!sessionId) return;
    this.emitter.emit(`session:${sessionId}`, ev);
    const step = this.sessions.get(sessionId);
    if (!step) return;
    const live = this.sanitize(ev);
    if (live) this.publish(step.taskId, live);
  }

  private sanitize(ev: HarnessEvent): LiveEvent | undefined {
    const at = new Date().toISOString();
    switch (ev.type) {
      case 'message.updated':
        this.roles.set(ev.properties.info.id, ev.properties.info.role);
        if (this.roles.size > 5000) this.roles.delete(this.roles.keys().next().value!);
        return undefined;
      case 'message.part.delta': {
        const { partID, messageID, field, delta } = ev.properties;
        if (field !== 'text' || this.roles.get(messageID) !== 'assistant') return undefined;
        const text = (this.texts.get(partID) ?? '') + delta;
        this.texts.set(partID, text.slice(-LIVE_EVENT_MAX_TEXT * 2));
        return { type: 'text', at, partId: partID, ...tail(text) };
      }
      case 'message.part.updated': {
        const part = ev.properties.part;
        if (part.type === 'text') {
          if (this.roles.get(part.messageID) !== 'assistant' || part.synthetic) return undefined;
          this.texts.set(part.id, part.text.slice(-LIVE_EVENT_MAX_TEXT * 2));
          return { type: 'text', at, partId: part.id, ...tail(part.text) };
        }
        if (part.type === 'reasoning') return { type: 'reasoning', at, partId: part.id, ...tail(part.text) };
        if (part.type === 'tool') {
          const st = part.state;
          const file = (st.input?.filePath ?? st.input?.path) as string | undefined;
          return {
            type: 'tool',
            at,
            partId: part.id,
            tool: part.tool,
            status: st.status,
            title: st.status === 'completed' || st.status === 'running' ? st.title?.slice(0, 200) : undefined,
            files: file ? [path.posix.relative(this.workspaceDir, file)] : undefined,
            output:
              st.status === 'completed' ? st.output.slice(0, LIVE_EVENT_MAX_TEXT) : st.status === 'error' ? st.error.slice(0, LIVE_EVENT_MAX_TEXT) : undefined,
          };
        }
        if (part.type === 'step-finish') {
          return { type: 'tokens', at, input: part.tokens.input, output: part.tokens.output, cost: part.cost || undefined };
        }
        return undefined;
      }
      case 'session.error': {
        const e = ev.properties.error;
        const message = e && 'message' in e.data && typeof e.data.message === 'string' ? e.data.message : (e?.name ?? 'error');
        return { type: 'error', at, message: message.slice(0, 500) };
      }
      default:
        return undefined;
    }
  }
}
