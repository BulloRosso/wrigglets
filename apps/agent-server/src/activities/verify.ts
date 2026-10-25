import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactPaths, stepFileName, workspacePaths } from '@cw/shared';
import type { VerifyInput, VerifyResult } from '@cw/workflows/activity-types';
import { isProtectedPath } from '../workspace/paths.js';
import type { ActivityDeps } from './deps.js';

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * Deterministic checks, no LLM (spec §7.6 `verify`):
 *  - the task's commits only touch allowed paths,
 *  - a summary exists for every step,
 *  - optional type-specific plug-in script `scripts/verify/<type>.(py|mjs|js)`:
 *    exit code 0 = ok, stdout JSON array = anomalies; non-zero exit = failure.
 */
export function createVerify(deps: ActivityDeps) {
  const { config, git } = deps;

  return async function verify(input: VerifyInput): Promise<VerifyResult> {
    const failures: string[] = [];
    const anomalies: string[] = [];

    const commits = (await git.log({ grep: `Task-Id: ${input.taskId}`, files: true, limit: 1000 })).filter((c) =>
      c.trailers['Task-Id']?.includes(input.taskId),
    );
    const touched = [...new Set(commits.flatMap((c) => c.files ?? []))].sort();
    // Net effect: a file the task created and removed again (e.g. a report first written to the wrong place and then
    // moved to reports/) is no change. Files that existed before the task count, also when deleted.
    const first = commits[commits.length - 1]?.hash;
    const existsAt = (rev: string, f: string) => git.run(['cat-file', '-e', `${rev}:${f}`]).then(
      () => true,
      () => false,
    );
    const changed: string[] = [];
    for (const f of touched) {
      if (first && !(await existsAt('HEAD', f)) && !(await existsAt(`${first}^`, f))) continue;
      changed.push(f);
    }
    const ownPrefix = stepFileName(input.taskId);

    for (const f of changed) {
      if (isProtectedPath(f)) failures.push(`Protected path was modified: ${f}`);
      else if (f.startsWith('.agent/plans/') && f !== workspacePaths.plan(input.taskId) && !f.endsWith('.gitkeep')) {
        failures.push(`Plan of another task was modified: ${f}`);
      } else if ((f.startsWith('.agent/summaries/') || f.startsWith('.agent/steps/')) && !path.posix.basename(f).startsWith(ownPrefix)) {
        failures.push(`Record of another task was modified: ${f}`);
      } else if ((input.type === 'analysis' || input.type === 'report') && !f.startsWith('.agent/') && !f.startsWith('reports/')) {
        failures.push(`${input.type} tasks may only write to reports/ (changed: ${f})`);
      }
    }

    for (const stepId of input.stepIds.filter((s) => !s.includes(':upload:'))) {
      if (!(await exists(path.join(config.workspaceDir, workspacePaths.summary(stepId))))) {
        failures.push(`Summary missing for step ${stepId}`);
      }
    }

    const plugin = await findPlugin(config.workspaceDir, input.type);
    let pluginOutput = '';
    if (plugin) {
      const r = await runPlugin(plugin, config.workspaceDir, { TASK_ID: input.taskId, TASK_TYPE: input.type, CHANGED_FILES: changed.join('\n') });
      pluginOutput = `exit ${r.code}\n\nstdout:\n${r.stdout.slice(0, 8000)}\n\nstderr:\n${r.stderr.slice(0, 4000)}`;
      const parsed = parseAnomalies(r.stdout);
      if (r.code === 0) anomalies.push(...parsed);
      else failures.push(...(parsed.length ? parsed : [`Verification script ${path.basename(plugin)} failed with exit code ${r.code}`]));
    }

    const reportRel = artifactPaths.verifyReport(input.taskId, input.round);
    const report = [
      `# Verification ${input.round} — ${input.taskId}`,
      '',
      `Result: **${failures.length === 0 ? 'OK' : 'FAILED'}**`,
      '',
      '## Changed files',
      ...(changed.length ? changed.map((f) => `- ${f}`) : ['- (none)']),
      '',
      '## Failures',
      ...(failures.length ? failures.map((f) => `- ${f}`) : ['- none']),
      '',
      '## Anomalies',
      ...(anomalies.length ? anomalies.map((f) => `- ${f}`) : ['- none']),
      '',
      '## Plug-in',
      plugin ? `\`${path.relative(config.workspaceDir, plugin)}\`\n\n\`\`\`\n${pluginOutput}\n\`\`\`` : 'No verification script for this task type.',
      '',
    ].join('\n');
    await mkdir(path.dirname(path.join(config.artifactsDir, reportRel)), { recursive: true });
    await writeFile(path.join(config.artifactsDir, reportRel), report);

    return { ok: failures.length === 0, reportPath: reportRel, failures: failures.slice(0, 50), anomalies: anomalies.slice(0, 50) };
  };
}

async function findPlugin(workspace: string, type: string): Promise<string | undefined> {
  for (const ext of ['py', 'mjs', 'js']) {
    const p = path.join(workspace, 'scripts', 'verify', `${type}.${ext}`);
    if (await exists(p)) return p;
  }
  return undefined;
}

function runPlugin(file: string, cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = file.endsWith('.py') ? 'python3' : process.execPath;
  return new Promise((resolve) => {
    execFile(cmd, [file], { cwd, env: { PATH: process.env.PATH, ...env }, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

export function parseAnomalies(stdout: string): string[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    const list = Array.isArray(v) ? v : (v as { anomalies?: unknown[] }).anomalies ?? [];
    return list.map((a) => (typeof a === 'string' ? a : (a as { message?: string }).message ?? JSON.stringify(a))).slice(0, 50);
  } catch {
    return [];
  }
}
