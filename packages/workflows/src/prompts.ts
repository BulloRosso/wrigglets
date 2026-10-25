import { stepFileName, workspacePaths, type TaskInput } from '@cw/shared';
import type { VerifyResult } from './activity-types.js';

/*
 * Prompt builders. Pure functions, deterministic. The step footer (summary file instruction)
 * is appended by the `runAgentStep` activity because it knows the step id.
 *
 * Convention: every instruction that asks the harness to create a file names the path in
 * backticks on a line that starts with "Write". (The mock LLM relies on this, real models
 * simply read it as an instruction.)
 */

const header = (taskId: string, input: TaskInput) =>
  [
    `# Task ${taskId}`,
    `Title: ${input.title}`,
    `Type: ${input.type}`,
    `Requested by: ${input.requestedBy.name} <${input.requestedBy.upn}>`,
    '',
    '## Instructions from the requester',
    input.instructions,
    '',
  ].join('\n');

export function planPrompt(taskId: string, input: TaskInput, revision?: { comment: string; by: string }): string {
  const lines = [
    header(taskId, input),
    '## Your job in this step: PLAN',
    'Analyse the workspace and the instructions. Do not change any file other than the plan file.',
    `Write the plan to \`${workspacePaths.plan(taskId)}\` as Markdown with the sections: Goal, Inputs, Steps (numbered), Outputs (with paths), Risks and open questions.`,
  ];
  if (revision) {
    lines.push(
      '',
      `## Requested changes (from ${revision.by})`,
      revision.comment,
      'Update the existing plan file so that it addresses these requested changes.',
    );
  }
  return lines.join('\n');
}

export function runPrompt(taskId: string, input: TaskInput, approval?: { comment?: string; by: string }): string {
  const lines = [
    header(taskId, input),
    '## Your job in this step: EXECUTE',
    `Execute the plan stored in \`${workspacePaths.plan(taskId)}\`.`,
  ];
  if (approval?.comment) lines.push(`The plan was approved by ${approval.by} with this comment: ${approval.comment}`);
  if (input.type === 'report' || input.type === 'analysis') {
    lines.push(`Write the main result to \`reports/${stepFileName(taskId)}.md\` unless the plan names a different output path.`);
    lines.push(
      'The report must contain the actual answer itself — the concrete results, numbers, tables and conclusions the request asks for — ' +
        'written for the requester. Do not only describe what you did or where the result is.',
    );
  }
  lines.push('Only change files that the plan requires. Never touch `.git`, `AGENTS.md` or `opencode.json`.');
  return lines.join('\n');
}

export function fixPrompt(taskId: string, input: TaskInput, verify: VerifyResult, comment?: string): string {
  const lines = [
    header(taskId, input),
    '## Your job in this step: FIX',
    `The automatic verification reported problems (full report: artifacts \`${verify.reportPath}\`).`,
  ];
  if (verify.failures.length) lines.push('', 'Failures:', ...verify.failures.map((f) => `- ${f}`));
  if (verify.anomalies.length) lines.push('', 'Anomalies:', ...verify.anomalies.map((f) => `- ${f}`));
  if (comment) lines.push('', `Reviewer comment: ${comment}`);
  lines.push('', 'Fix the problems with minimal changes. Do not modify files unrelated to this task.');
  return lines.join('\n');
}

export function integratePrompt(
  taskId: string,
  input: TaskInput,
  results: Array<{ agentId: string; taskId: string; state: string; result: string }>,
): string {
  const lines = [
    header(taskId, input),
    '## Your job in this step: INTEGRATE DELEGATED RESULTS',
    'Tasks you delegated to other AI colleagues have finished. Their results:',
  ];
  for (const r of results) {
    lines.push('', `### ${r.agentId} — task ${r.taskId} (${r.state})`, r.result.slice(0, 8000));
  }
  lines.push('', 'Integrate these results into your deliverables. If a delegated task did not complete, say so explicitly.');
  return lines.join('\n');
}
