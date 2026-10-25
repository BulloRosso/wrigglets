import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import { workspacePaths } from '@cw/shared';
import type { FinalizeTaskInput, FinalizeTaskResult } from '@cw/workflows/activity-types';
import { logger } from '../logger.js';
import { metrics } from '../telemetry.js';
import { decodeHistory } from '../timeline/history.js';
import { mapHistory } from '../timeline/mapHistory.js';
import type { ActivityDeps } from './deps.js';
import { stepTrailers } from './trailers.js';

/**
 * Final commit + permanent audit export (spec §7.9). Also called for unsuccessful outcomes.
 * Optionally reverts the task's run/fix commits (deviation rejected).
 */
export function createFinalizeTask(deps: ActivityDeps) {
  const { config, git } = deps;

  return async function finalizeTask(input: FinalizeTaskInput): Promise<FinalizeTaskResult> {
    const { workflowId, runId } = Context.current().info.workflowExecution!;
    const stepId = `${input.taskId}:finalize:${input.outcome}`;
    const auditRel = workspacePaths.audit(input.taskId, new Date(input.state.createdAt));

    const existing = await git.findCommitByTrailer('Step-Id', stepId);
    if (existing) return { finalCommit: existing, auditPath: auditRel, reverted: [] };
    if (await git.isDirty()) await git.resetToHead();

    // Optional revert of run/fix commits (newest first).
    const reverted: string[] = [];
    let revertError: string | undefined;
    if (input.revert) {
      const commits = (await git.log({ grep: `Task-Id: ${input.taskId}`, limit: 500 })).filter(
        (c) => c.trailers['Task-Id']?.includes(input.taskId) && /:(run|fix):/.test(c.trailers['Step-Id']?.[0] ?? ''),
      );
      if (commits.length) {
        const r = await git.run(['revert', '--no-commit', ...commits.map((c) => c.hash)], { allowFail: true });
        if (/error|conflict/i.test(r.stderr)) {
          await git.run(['revert', '--abort'], { allowFail: true });
          await git.resetToHead();
          revertError = r.stderr.trim().slice(0, 500);
          logger.warn({ taskId: input.taskId, revertError }, 'revert failed');
        } else {
          // Keep the records of what was done (summaries, step results) — only the work is reverted.
          await git.run(['checkout', 'HEAD', '--', '.agent/summaries', '.agent/steps'], { allowFail: true });
          reverted.push(...commits.map((c) => c.shortHash));
        }
      }
    }

    // Audit export: input, final state, mapped timeline and the decoded raw history.
    const handle = deps.temporal().workflow.getHandle(workflowId, runId);
    const history = await handle.fetchHistory();
    const events = await decodeHistory(history, deps.codec);
    const started = events[0]?.workflowExecutionStartedEventAttributes as { input?: { payloads?: unknown[] } } | undefined;
    const taskInput = started?.input?.payloads?.[0] as Record<string, unknown> | undefined;
    const audit = {
      exportedAt: new Date().toISOString(),
      agentId: config.AGENT_ID,
      taskId: input.taskId,
      workflowId,
      runId,
      outcome: input.outcome,
      input: taskInput ? { ...taskInput, attachments: (taskInput.attachments as unknown[] | undefined)?.length ?? 0 } : undefined,
      state: input.state,
      reverted,
      revertError,
      timeline: mapHistory(events, { laneId: input.taskId, laneLabel: input.state.title }),
      history: events,
    };
    const auditAbs = path.join(config.workspaceDir, auditRel);
    await mkdir(path.dirname(auditAbs), { recursive: true });
    await writeFile(auditAbs, `${JSON.stringify(audit, null, 2)}\n`);

    const finalCommit = await git.commitAll({
      subject: `chore(${input.taskId}): finalize — ${input.outcome}${reverted.length ? ` (reverted ${reverted.length} commit(s))` : ''}`,
      body: input.state.result?.summary ?? input.state.error,
      trailers: stepTrailers({ meta: input.meta, taskId: input.taskId, workflowId, runId, stepId, extra: { 'Audit-Export': input.taskId, Outcome: input.outcome } }),
    });
    (input.outcome === 'completed' ? metrics.tasksCompleted : metrics.tasksFailed).add(1, { type: input.state.type, outcome: input.outcome });
    return { finalCommit, auditPath: auditRel, reverted, revertError };
  };
}

/** Reads an audit export (used by the API when a workflow is beyond retention). */
export async function readAuditExport(workspaceDir: string, rel: string): Promise<unknown | undefined> {
  return JSON.parse(await readFile(path.join(workspaceDir, rel), 'utf8').catch(() => 'null')) ?? undefined;
}
