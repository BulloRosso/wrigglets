import { mkdir, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { WorkflowNotFoundError } from '@temporalio/client';
import type { MaintenanceResult, NotifyInput } from '@cw/workflows/activity-types';
import { logger } from '../logger.js';
import type { ActivityDeps } from './deps.js';

const NOTIFY_TEXT: Record<NotifyInput['kind'], string> = {
  approval_requested: 'needs your approval',
  approval_reminder: 'is still waiting for your approval',
  completed: 'was completed',
  failed: 'failed',
  rejected: 'was rejected',
  cancelled: 'was cancelled',
  expired: 'expired without a decision',
  budget_exceeded: 'stopped: token budget exhausted',
};

/**
 * Human in the loop (ADR-0026): the control plane mails everybody with access to this agent, with links into the
 * decision dialog. Best effort — a failed mail must not fail (and thereby repeat) the notification activity.
 */
async function mailApprovalRequest(deps: ActivityDeps, input: NotifyInput, link: string) {
  const { CONTROL_PLANE_URL: base, CONTROL_PLANE_TOKEN: token, AGENT_ID } = deps.config;
  if (!base || !token) return;
  try {
    const res = await fetch(`${base}/internal/agents/${encodeURIComponent(AGENT_ID)}/notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: input.kind,
        taskId: input.taskId,
        title: input.title,
        text: input.text,
        link,
        requestedBy: input.to[0] ? { upn: input.to[0].upn, name: input.to[0].name } : undefined,
        awaiting: /deviation/i.test(input.text ?? '') ? 'deviation' : 'plan',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`control plane returned ${res.status}`);
    const r = (await res.json()) as { recipients: number; status: string };
    logger.info({ taskId: input.taskId, recipients: r.recipients, status: r.status }, 'approval request mailed');
  } catch (err) {
    logger.warn({ taskId: input.taskId, err: String(err) }, 'approval mail not sent');
  }
}

export function createNotify(deps: ActivityDeps) {
  return async function notify(input: NotifyInput): Promise<void> {
    const link = `${deps.config.publicBaseUrl}/tasks/${encodeURIComponent(input.taskId)}`;
    for (const to of input.to) {
      await deps.notifications.append({ to: to.upn, kind: input.kind, taskId: input.taskId, title: input.title, text: input.text });
    }
    if (input.kind === 'approval_requested' || input.kind === 'approval_reminder') await mailApprovalRequest(deps, input, link);
    const url = deps.config.NOTIFY_TEAMS_WEBHOOK_URL;
    if (url) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', weight: 'Bolder', text: `${deps.config.AGENT_DISPLAY_NAME}: "${input.title}" ${NOTIFY_TEXT[input.kind]}` },
                  ...(input.text ? [{ type: 'TextBlock', wrap: true, text: input.text }] : []),
                ],
                actions: [{ type: 'Action.OpenUrl', title: 'Open task', url: link }],
              },
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Teams webhook failed: ${res.status}`);
    }
  };
}

export function createIsWorkflowRunning(deps: ActivityDeps) {
  return async function isWorkflowRunning({ workflowId }: { workflowId: string }): Promise<boolean> {
    try {
      const d = await deps.temporal().workflow.getHandle(workflowId).describe();
      return d.status.name === 'RUNNING';
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return false;
      throw err;
    }
  };
}

export function createMaintenance(deps: ActivityDeps) {
  const { git, config } = deps;

  async function gitMaintenance(): Promise<MaintenanceResult> {
    if (await git.isDirty()) await git.resetToHead();
    const before = (await git.run(['count-objects', '-v'])).stdout;
    await git.run(['gc', '--prune=30.days.ago', '--quiet']);
    const fsck = await git.run(['fsck', '--no-progress'], { allowFail: true });
    const after = (await git.run(['count-objects', '-v'])).stdout;
    return { kind: 'git', details: { before, after, fsck: (fsck.stdout + fsck.stderr).trim().slice(0, 4000) || 'ok' } };
  }

  async function backupWorkspace({ date }: { date: string }): Promise<MaintenanceResult> {
    const name = `workspace-${config.AGENT_ID}-${date}.bundle`;
    const tmp = path.join(config.artifactsDir, '.tmp');
    await mkdir(tmp, { recursive: true });
    const file = path.join(tmp, name);
    await git.run(['bundle', 'create', file, '--all']);
    let location: string;
    if (config.BACKUP_TARGET === 'azure-blob') {
      const { ContainerClient } = await import('@azure/storage-blob');
      const { DefaultAzureCredential } = await import('@azure/identity');
      const container = new ContainerClient(config.BACKUP_CONTAINER_URL!, new DefaultAzureCredential());
      const blob = container.getBlockBlobClient(`${config.AGENT_ID}/${name}`);
      await blob.uploadStream(createReadStream(file));
      location = blob.url;
      // Retention is enforced by a storage lifecycle rule (35 days) on Azure.
    } else if (config.BACKUP_TARGET === 'local') {
      await mkdir(config.backupDir, { recursive: true });
      location = path.join(config.backupDir, name);
      await copyFile(file, location);
      const cutoff = Date.now() - config.BACKUP_KEEP_DAYS * 86_400_000;
      for (const f of await readdir(config.backupDir)) {
        const p = path.join(config.backupDir, f);
        if (f.endsWith('.bundle') && (await stat(p)).mtimeMs < cutoff) await rm(p, { force: true });
      }
    } else {
      location = 'none';
    }
    await rm(file, { force: true });
    logger.info({ location }, 'workspace backup written');
    return { kind: 'backup', details: { location } };
  }

  async function cleanupArtifacts({ olderThanDays }: { olderThanDays: number }): Promise<MaintenanceResult> {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    let deleted = 0;
    for (const dir of await readdir(config.artifactsDir).catch(() => [] as string[])) {
      if (!dir.startsWith('task-') && !dir.startsWith('maint-')) continue;
      const full = path.join(config.artifactsDir, dir);
      for (const f of await readdir(full).catch(() => [] as string[])) {
        if (!f.endsWith('-transcript.json')) continue;
        const p = path.join(full, f);
        if ((await stat(p)).mtimeMs < cutoff) {
          await rm(p, { force: true });
          deleted += 1;
        }
      }
    }
    return { kind: 'artifacts', details: { deleted, olderThanDays } };
  }

  return { gitMaintenance, backupWorkspace, cleanupArtifacts };
}
