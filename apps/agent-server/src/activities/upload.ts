import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { ApplyUploadInput, ApplyUploadResult } from '@cw/workflows/activity-types';
import { isInside, isProtectedPath, resolveWorkspacePath } from '../workspace/paths.js';
import type { ActivityDeps } from './deps.js';
import { stepTrailers } from './trailers.js';

/** Moves staged uploads into the workspace and commits them with the human as author (spec §8.2). */
export function createApplyUpload(deps: ActivityDeps) {
  const { config, git } = deps;

  return async function applyUpload(input: ApplyUploadInput): Promise<ApplyUploadResult> {
    const { workflowId, runId } = Context.current().info.workflowExecution!;
    const stepId = `${input.taskId}:upload:1`;
    const marker = path.join(config.stagingDir, input.taskId, '.result.json');

    const existing = await git.findCommitByTrailer('Step-Id', stepId);
    if (existing) {
      const stored = JSON.parse(await readFile(marker, 'utf8').catch(() => '{"paths":[]}')) as { paths: string[] };
      return { commit: existing, paths: stored.paths };
    }
    if (await git.isDirty()) await git.resetToHead();

    const paths: string[] = [];
    for (const f of input.files) {
      const src = path.resolve(config.stagingDir, f.stagingPath);
      if (!isInside(config.stagingDir, src)) throw ApplicationFailure.nonRetryable(`Invalid staging path ${f.stagingPath}`);
      const { abs, rel } = await resolveWorkspacePath(config.workspaceDir, f.targetPath, { mustExist: false });
      if (!rel || isProtectedPath(rel) || rel.startsWith('.agent/')) {
        throw ApplicationFailure.nonRetryable(`Uploads may not write to ${f.targetPath}`, 'InvalidUploadTarget');
      }
      await mkdir(path.dirname(abs), { recursive: true });
      await copyFile(src, abs);
      paths.push(rel);
    }

    const commit = await git.commitAll({
      subject: `upload(${input.taskId}): ${paths.length} file(s) — ${paths.slice(0, 3).join(', ')}`.slice(0, 120),
      trailers: stepTrailers({ meta: input.meta, taskId: input.taskId, workflowId, runId, stepId }),
      author: { name: input.requestedBy.name || input.requestedBy.upn, email: input.requestedBy.upn },
    });
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, JSON.stringify({ paths }));
    for (const f of input.files) await rm(path.resolve(config.stagingDir, f.stagingPath), { force: true });
    return { commit, paths };
  };
}
