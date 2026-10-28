import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { artifactPaths, formatUsd, workspacePaths } from '@cw/shared';
import {
  ACTIVITY_ERRORS,
  type BudgetExceededDetails,
  type RunAgentStepInput,
  type RunAgentStepResult,
} from '@cw/workflows/activity-types';
import { logger } from '../logger.js';
import { safetyStats } from '../safetyStats.js';
import { metrics } from '../telemetry.js';
import type { ActivityDeps } from './deps.js';
import { stepTrailers } from './trailers.js';

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * One Agent Harness turn = one activity (spec §7.6 "runAgentStep in detail").
 * Idempotent through Git checkpoints: a committed step is never executed twice.
 */
export function createRunAgentStep(deps: ActivityDeps) {
  const { config, git, harness, events } = deps;

  return async function runAgentStep(input: RunAgentStepInput): Promise<RunAgentStepResult> {
    const ctx = Context.current();
    const { workflowId, runId } = ctx.info.workflowExecution!;
    const log = logger.child({ taskId: input.taskId, stepId: input.stepId, attempt: ctx.info.attempt });
    const stepResultPath = path.join(config.workspaceDir, workspacePaths.stepResult(input.stepId));
    const summaryRel = workspacePaths.summary(input.stepId);

    // 1. Checkpoint / idempotency (spec §8.3)
    const existing = await git.findCommitByTrailer('Step-Id', input.stepId);
    if (existing) {
      const stored = JSON.parse(await readFile(stepResultPath, 'utf8')) as RunAgentStepResult;
      log.info({ commit: existing }, 'step already committed — returning stored result');
      return { ...stored, commit: existing, reused: true };
    }
    if (await git.isDirty()) {
      log.warn('workspace dirty before step — resetting to last checkpoint');
      await git.resetToHead();
    }

    // 1b. Real AI model and spend limit (ADR-0029): checked via the LiteLLM API before any model call
    const spend = await deps.spend.get();
    if (spend && !spend.ai.configured) {
      throw ApplicationFailure.nonRetryable(
        `No AI model available: ${spend.ai.problem ?? 'not configured'}. ${spend.ai.howToFix ?? ''}`.trim(),
        ACTIVITY_ERRORS.aiNotConfigured,
      );
    }
    if (spend?.exceeded) {
      throw ApplicationFailure.create({
        message: `Spend limit of ${formatUsd(spend.limitUsd)} per ${spend.windowDays} days reached (${formatUsd(spend.spentUsd)} spent). An administrator can raise the limit.`,
        type: ACTIVITY_ERRORS.budgetExceeded,
        nonRetryable: true,
      });
    }

    // 2. Harness + session
    if (!(await deps.supervisor.waitUntilHealthy(60_000))) {
      throw ApplicationFailure.retryable('Agent Harness is not available', ACTIVITY_ERRORS.harnessUnavailable);
    }
    let sessionId = input.sessionId;
    let preamble = '';
    if (!sessionId || !(await harness.sessionExists(sessionId))) {
      const created = await harness.createSession({ title: short(`${input.taskId} · ${input.context.title}`, 100) });
      if (sessionId || input.context.previousSummaries.length > 0) preamble = contextPreamble(input);
      sessionId = created.sessionId;
      log.info({ sessionId, recovered: !!preamble }, 'harness session created');
    }

    // The exfiltration guard stopped this session (ADR-0033): end the step as cancelled; the guard has cancelled the task.
    const stoppedByGuard = () => {
      const halt = deps.guard?.haltOf(sessionId!);
      if (!halt) return;
      deps.guard!.clearHalt(sessionId!);
      throw new CancelledFailure(`Stopped by the security guard: ${halt.reason}`);
    };

    // 3. Heartbeats on every harness event, at least every 30 s
    let lastEventType = 'none';
    let toolEvents = 0;
    const heartbeat = () => ctx.heartbeat({ lastEventType, toolEvents });
    const unsubscribe = events.onSession(sessionId, (ev) => {
      lastEventType = ev.type;
      if (ev.type === 'message.part.updated' && ev.properties.part.type === 'tool') toolEvents += 1;
      heartbeat();
    });
    const timer = setInterval(heartbeat, 30_000);
    events.beginStep(sessionId, { taskId: input.taskId, stepId: input.stepId, kind: input.kind });

    // 4. Cancellation → abort the harness session
    const abortHarness = () => void harness.abort(sessionId!).catch((err) => log.warn({ err: String(err) }, 'abort failed'));
    ctx.cancellationSignal.addEventListener('abort', abortHarness, { once: true });

    // 5. Prompt with step footer
    const footer = `\n\n---\nWhen finished, write a 3–6 sentence summary of this step to \`${summaryRel}\`. Do not commit.`;
    const startedAt = new Date();
    let turn;
    const guardedBefore = deps.guard?.evaluationsOf(sessionId) ?? 0;
    // `interactive`: a signed-in user is behind the task (not a schedule or A2A delegation) — decides Entra OBO vs. agent-only
    await deps.gateway.setStepContext({ taskId: input.taskId, requestedBy: input.requestedBy, interactive: input.meta.trigger === 'user', phase: input.kind });
    try {
      heartbeat();
      const wiki = await wikiBrief(config.workspaceDir, input.kind);
      turn = await harness.prompt({ sessionId, text: `${wiki}${preamble}${input.prompt}${footer}`, signal: ctx.cancellationSignal });
      if (wiki) log.info({ stepKind: input.kind, wikiReads: turn.wikiReads?.length ?? 0, pages: turn.wikiReads }, 'wiki use');
    } catch (err) {
      stoppedByGuard();
      if (ctx.cancellationSignal.aborted) throw new CancelledFailure('Step cancelled');
      safetyStats.recordStepFailure();
      throw ApplicationFailure.retryable(`Harness request failed: ${String(err)}`, ACTIVITY_ERRORS.harnessUnavailable);
    } finally {
      void deps.gateway.setStepContext(undefined);
      clearInterval(timer);
      unsubscribe();
      events.endStep(sessionId);
      ctx.cancellationSignal.removeEventListener('abort', abortHarness);
    }
    stoppedByGuard();
    if (ctx.cancellationSignal.aborted) throw new CancelledFailure('Step cancelled');

    // The harness plugin must have shown every tool call to the exfiltration guard. If tools ran successfully and the guard
    // saw none, the hook is not active (e.g. the harness did not load the plugin): fail loudly instead of running unguarded
    // (ADR-0033). Calls refused by the harness's own permissions never reach the hook, hence only successful ones count.
    if (deps.guard && turn.toolCalls.some((t) => t.status === 'ok') && deps.guard.evaluationsOf(sessionId) === guardedBefore && (await deps.guard.getConfig()).enabled) {
      log.error({ toolCalls: turn.toolCalls.length }, 'exfiltration guard saw no tool call — harness plugin inactive');
      throw ApplicationFailure.nonRetryable(
        'The exfiltration guard did not see any of the tool calls of this step, so the harness plugin is not active. The step was stopped; an administrator must check the harness (see docs/exfiltration-guard.md).',
        ACTIVITY_ERRORS.guardInactive,
      );
    }

    // 6. Evaluate
    if (events.permissionViolations.has(sessionId)) {
      throw ApplicationFailure.nonRetryable('The harness requested an interactive permission', ACTIVITY_ERRORS.permissionDenied);
    }
    safetyStats.recordTokens(turn.tokens.total);
    if (turn.error) safetyStats.recordStepFailure();
    if (turn.error?.kind === 'provider' && /budget has been exceeded|exceededbudget|max budget/i.test(turn.error.message)) {
      // LiteLLM's key budget is the backstop of the spend limit
      throw ApplicationFailure.create({ message: `Spend limit reached: ${turn.error.message}`, type: ACTIVITY_ERRORS.budgetExceeded, nonRetryable: true });
    }
    if (turn.error?.kind === 'provider') throw ApplicationFailure.retryable(turn.error.message, ACTIVITY_ERRORS.provider);
    if (turn.error?.kind === 'permission') throw ApplicationFailure.nonRetryable(turn.error.message, ACTIVITY_ERRORS.permissionDenied);
    if (turn.error?.kind === 'aborted') throw ApplicationFailure.retryable('Harness turn was aborted', 'Aborted');

    // Summary file: written by the harness; fall back to its final answer so every step has one.
    const summaryAbs = path.join(config.workspaceDir, summaryRel);
    let summary = await readFile(summaryAbs, 'utf8').catch(() => '');
    if (!summary.trim()) {
      summary = turn.finalText.trim() || `Step ${input.stepId} finished without a summary.`;
      await mkdir(path.dirname(summaryAbs), { recursive: true });
      await writeFile(summaryAbs, `${summary}\n\n_(summary generated by the platform from the final answer)_\n`);
    }

    // 8. Transcript export + step result file
    const transcriptRel = artifactPaths.transcript(input.taskId, input.stepId);
    const transcriptAbs = path.join(config.artifactsDir, transcriptRel);
    await mkdir(path.dirname(transcriptAbs), { recursive: true });
    const messages = await harness.messages(sessionId).catch(() => []);
    await writeFile(transcriptAbs, JSON.stringify({ taskId: input.taskId, stepId: input.stepId, sessionId, messages }, null, 2));

    const endedAt = new Date();
    const changed = await git.changedFiles();
    const result: RunAgentStepResult = {
      sessionId,
      summary: short(summary, 600),
      commit: '',
      tokens: turn.tokens.total,
      tokenDetail: { input: turn.tokens.input, output: turn.tokens.output, reasoning: turn.tokens.reasoning, cacheRead: turn.tokens.cacheRead },
      cost: turn.cost,
      artifacts: [transcriptRel],
      filesTouched: [...new Set([...turn.filesTouched, ...changed])].filter((f) => !f.startsWith('.agent/steps/')).slice(0, 200),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      reused: false,
      delegations: turn.delegations.length ? turn.delegations : undefined,
    };
    await mkdir(path.dirname(stepResultPath), { recursive: true });
    await writeFile(stepResultPath, JSON.stringify(result, null, 2));

    // 9. Commit (one per step, also when empty)
    const commit = await git.commitAll({
      subject: `${input.taskType}(${input.taskId}): ${input.kind} — ${short(summary, 60)}`,
      body: summary,
      trailers: stepTrailers({ meta: input.meta, taskId: input.taskId, workflowId, runId, stepId: input.stepId }),
    });
    metrics.stepDuration.record(endedAt.getTime() - startedAt.getTime(), { kind: input.kind });
    metrics.tokensUsed.add(result.tokens, { kind: input.kind, model: config.AI_GATEWAY_MODEL });
    log.info({ commit, tokens: result.tokens, files: result.filesTouched.length, durationMs: endedAt.getTime() - startedAt.getTime() }, 'step committed');

    // 7. Budget (after committing, for traceability)
    if (result.tokens > input.budgetRemaining) {
      const details: BudgetExceededDetails = { commit, tokens: result.tokens, summary: result.summary };
      throw ApplicationFailure.create({
        message: `Token budget exceeded (${result.tokens} > ${input.budgetRemaining})`,
        type: ACTIVITY_ERRORS.budgetExceeded,
        nonRetryable: true,
        details: [details],
      });
    }
    return { ...result, commit };
  };
}

const WIKI_INDEX_MAX = 6_000;

/**
 * The agent's wiki is its memory between tasks (wiki/index.md, kept by the agent). The platform puts the index in front of
 * every plan and execute step, so that using the memory does not depend on the agent remembering to open it.
 */
async function wikiBrief(workspaceDir: string, kind: string): Promise<string> {
  if (kind === 'fix') return '';
  const index = await readFile(path.join(workspaceDir, 'wiki', 'index.md'), 'utf8').catch(() => '');
  const head = '## Your wiki: memory from your earlier tasks';
  if (!index.trim()) {
    return [head, 'You have no wiki yet. Create wiki/index.md and wiki/log.md as described in your standing instructions when you finish this task.', '', ''].join('\n');
  }
  const clipped = index.length > WIKI_INDEX_MAX ? `${index.slice(0, WIKI_INDEX_MAX)}\n[… index shortened]` : index;
  const ask =
    kind === 'plan'
      ? 'Before you plan, open the pages that fit this task (read tool) and use what they say. Add a line "Wiki: <pages you read and what you took from them>" to the plan, or "Wiki: none fit (index reviewed)". If a page contradicts what the tools show, trust the tools and correct the page in the execute step.'
      : 'Before you act, re-read the wiki pages named in the plan. After the result is known, update the wiki as your standing instructions describe.';
  return [head, 'Index (wiki/index.md):', '', clipped, '', ask, '', ''].join('\n');
}

function contextPreamble(input: RunAgentStepInput): string {
  const lines = [
    '## Context (the previous conversation was lost — the workspace is your memory)',
    `You are continuing task ${input.taskId}: "${input.context.title}".`,
  ];
  if (input.context.planPath) lines.push(`The approved plan is in \`${input.context.planPath}\`. Read it first.`);
  if (input.context.previousSummaries.length) {
    lines.push('Summaries of the previous steps (read them):', ...input.context.previousSummaries.map((p) => `- \`${p}\``));
  }
  return `${lines.join('\n')}\n\n`;
}
