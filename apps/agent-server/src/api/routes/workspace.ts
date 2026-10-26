import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { ulid } from 'ulid';
import { z } from 'zod';
import { agentWorkflowId, type CommitInfo, type RestorePoint, type StagingFile, type WorkspaceEntry } from '@cw/shared';
import { collectNames, groupChanges, isRestorePointCommit, type TaskMeta } from '../../workspace/changes.js';
import { SA, q } from '@cw/shared/search-attributes';
import { agentStatusQuery } from '@cw/workflows/messages';
import { isProtectedPath, resolveWorkspacePath, uploadFileName } from '../../workspace/paths.js';
import { HttpError, type ApiDeps } from '../context.js';
import { requireRole } from '../auth.js';
import { listExecutions, startTaskWorkflow } from './tasks.js';

const MAX_FILE = 20 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.svg': 'text/plain; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.mermaid': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MAX_AGENTS_MD = 256 * 1024;
const agentsMdBody = z.object({ content: z.string().max(MAX_AGENTS_MD), by: z.object({ upn: z.string().min(1), name: z.string().optional() }).optional() });

/** AGENTS.md is protected from tasks and uploads; only administrators edit it, directly, as a commit authored by them. */
export function agentsMdHandlers(deps: ApiDeps) {
  const { config, git } = deps;
  const file = path.join(config.workspaceDir, 'AGENTS.md');
  const get: RequestHandler = async (_req, res) => {
    res.json({ content: await readFile(file, 'utf8').catch(() => '') });
  };
  const put = (identity: (req: Parameters<RequestHandler>[0]) => { upn: string; name?: string }): RequestHandler => async (req, res) => {
    const body = agentsMdBody.parse(req.body);
    const by = identity(req);
    if (body.content.includes('\0')) throw new HttpError(400, 'invalid content');
    const content = body.content === '' || body.content.endsWith('\n') ? body.content : `${body.content}\n`;
    await writeFile(file, content, 'utf8');
    const commit = await git.commitPaths(['AGENTS.md'], {
      subject: 'docs(agents): update AGENTS.md',
      trailers: { 'Requested-By': by.upn, Trigger: 'manual' },
      author: { name: by.name || by.upn, email: by.upn },
    });
    await deps.audit.write({ by: by.upn, action: 'agents-md.update', target: 'AGENTS.md', details: { commit } });
    res.json({ commit: commit ?? null });
  };
  return { get, put };
}

/** Read-only workspace access for users; writes only through upload tasks (spec §2.2 #5, §8.4). */
export function workspaceRouter(deps: ApiDeps): Router {
  const r = Router();
  const { config, git } = deps;

  r.get('/workspace/tree', async (req, res) => {
    const { abs, rel } = await resolveWorkspacePath(config.workspaceDir, String(req.query.path ?? ''));
    const entries = await readdir(abs, { withFileTypes: true });
    const out: WorkspaceEntry[] = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (childRel === '.git') continue;
      const s = await stat(path.join(abs, e.name)).catch(() => undefined);
      if (!s) continue;
      out.push({ name: e.name, path: childRel, type: s.isDirectory() ? 'dir' : 'file', size: s.isFile() ? s.size : undefined, modified: s.mtime.toISOString() });
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ path: rel, entries: out });
  });

  r.get('/workspace/file', async (req, res) => {
    const { abs, rel } = await resolveWorkspacePath(config.workspaceDir, String(req.query.path ?? ''));
    const s = await stat(abs);
    if (!s.isFile()) throw new HttpError(400, 'not a file');
    if (s.size > MAX_FILE) throw new HttpError(413, 'file too large for preview (max 20 MB)');
    const ext = path.extname(rel).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(s.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    if (req.query.download === '1' || !MIME[ext]) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rel).replace(/"/g, '')}"`);
    createReadStream(abs).pipe(res);
  });

  const agentsMd = agentsMdHandlers(deps);
  r.get('/workspace/agents-md', requireRole(config.roles.admin), agentsMd.get);
  r.put('/workspace/agents-md', requireRole(config.roles.admin), agentsMd.put((req) => ({ upn: req.user!.upn, name: req.user!.name })));

  r.get('/workspace/commits', async (req, res) => {
    const p = req.query.path ? (await resolveWorkspacePath(config.workspaceDir, String(req.query.path), { mustExist: false })).rel : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json(await git.log({ path: p, limit, files: true, grep: req.query.taskId ? `Task-Id: ${String(req.query.taskId)}` : undefined }));
  });

  /** Title and status of tasks (Temporal visibility); tasks beyond retention are simply missing. */
  const taskMeta = async (commits: CommitInfo[]): Promise<Map<string, TaskMeta>> => {
    const ids = [...new Set(commits.map((c) => c.trailers['Task-Id']?.[0]).filter((x): x is string => !!x))].slice(0, 100);
    const meta = new Map<string, TaskMeta>();
    if (!ids.length) return meta;
    for (const w of await listExecutions(deps, `WorkflowId IN (${ids.map(q).join(',')})`, ids.length * 2)) {
      meta.set(w.workflowId, {
        title: w.typedSearchAttributes.get(SA.TaskTitle),
        status: w.typedSearchAttributes.get(SA.TaskStatus) ?? w.status.name.toLowerCase(),
        requestedBy: w.typedSearchAttributes.get(SA.RequestedBy),
        requestedByName: typeof w.memo?.requestedByName === 'string' ? w.memo.requestedByName : undefined,
      });
    }
    return meta;
  };

  /** Workspace history for business users: one entry per task instead of the raw commits. */
  r.get('/workspace/activity', async (req, res) => {
    const p = req.query.path ? (await resolveWorkspacePath(config.workspaceDir, String(req.query.path), { mustExist: false })).rel : undefined;
    const all = await git.log({ limit: 500 });
    const finalizeByTask = new Map<string, string>();
    for (const c of all) {
      const t = c.trailers['Task-Id']?.[0];
      if (t && c.trailers['Audit-Export'] && !finalizeByTask.has(t)) finalizeByTask.set(t, c.hash);
    }
    const commits = p ? await git.log({ path: p, limit: 300, files: true }) : await git.log({ limit: 300, files: true });
    const tasks = await taskMeta(commits);
    const changes = groupChanges(commits, tasks, finalizeByTask, collectNames([...all, ...commits], tasks));
    // Tasks that touched no files are hidden, so the current state is that of the newest visible change.
    res.json(changes.map((c, i) => ({ ...c, current: !p && i === 0 })));
  });

  /** Timeline for non-Git users: one marker per finished task, plus the start and earlier restores. */
  r.get('/workspace/restore-points', async (_req, res) => {
    const commits = await git.log({ limit: 300 });
    const picked = commits.filter(isRestorePointCommit);
    const titles = new Map([...(await taskMeta(picked))].map(([id, m]) => [id, m.title] as const));
    const head = commits[0]?.hash;
    // A state only matters once per hash; the newest commit is the "current" marker even when it is a finalize commit.
    const points: RestorePoint[] = picked.map((c) => {
      const taskId = c.trailers['Task-Id']?.[0];
      const kind: RestorePoint['kind'] = c.trailers['Restored-To'] ? 'restore' : taskId ? 'task' : 'start';
      const label =
        kind === 'start'
          ? 'Workspace created'
          : kind === 'restore'
            ? 'Workspace was reset to an earlier state'
            : (titles.get(taskId!) ?? c.subject.replace(/^[^:]*:\s*/, '').slice(0, 80));
      return { hash: c.hash, date: c.date, kind, label, taskId, outcome: c.trailers['Outcome']?.[0], current: c.hash === head };
    });
    res.json(points);
  });

  /** Sets the workspace files back to a restore point (as a new commit, history stays). Only while no task runs. */
  r.post('/workspace/restore', async (req, res) => {
    const { hash } = z.object({ hash: z.string().regex(/^[0-9a-f]{40}$/i) }).parse(req.body);
    const status = await deps.temporal.workflow.getHandle(agentWorkflowId(config.AGENT_ID)).query(agentStatusQuery);
    if (status.holder) throw new HttpError(409, 'A task is currently working on the workspace. Please try again when it has finished.');
    const target = (await git.log({ limit: 300 })).find((c) => c.hash === hash);
    if (!target || !isRestorePointCommit(target)) throw new HttpError(400, 'not a restore point');
    const by = req.user!;
    const commit = await git.restoreTo(hash, {
      subject: `restore: workspace reset to state of ${target.date.slice(0, 16).replace('T', ' ')}`,
      trailers: { 'Requested-By': by.upn, Trigger: 'restore', 'Restored-To': hash },
      author: { name: by.name || by.upn, email: by.upn },
    });
    await deps.audit.write({ by: by.upn, action: 'workspace.restore', target: hash, details: { commit } });
    res.json({ commit: commit ?? null });
  });

  r.get('/workspace/commits/:hash', async (req, res) => {
    const text = await git.show(req.params.hash);
    res.type('text/plain').send(text.length > 2_000_000 ? `${text.slice(0, 2_000_000)}\n… (truncated)` : text);
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const dir = path.join(config.stagingDir, (req as unknown as { uploadId: string }).uploadId);
        mkdir(dir, { recursive: true }).then(() => cb(null, dir), (err) => cb(err, dir));
      },
      // UTF-8 file names (umlauts etc.) are kept; see uploadFileName
      filename: (_req, file, cb) => cb(null, uploadFileName(file.originalname)),
    }),
    limits: { fileSize: 50 * 1024 * 1024, files: 10 },
  });

  const uploadFields = z.object({ targetDir: z.string().max(300).default('uploads'), title: z.string().max(120).optional() });

  r.post(
    '/workspace/uploads',
    (req, _res, next) => {
      (req as unknown as { uploadId: string }).uploadId = `up-${ulid()}`;
      next();
    },
    upload.array('files', 10),
    async (req, res) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) throw new HttpError(400, 'no files');
      const fields = uploadFields.parse(req.body ?? {});
      const target = (await resolveWorkspacePath(config.workspaceDir, fields.targetDir, { mustExist: false })).rel;
      if (isProtectedPath(target) || target.startsWith('.agent')) throw new HttpError(400, 'invalid target directory');
      const uploadId = (req as unknown as { uploadId: string }).uploadId;
      const attachments: StagingFile[] = files.map((f) => ({
        stagingPath: `${uploadId}/${f.filename}`,
        targetPath: target ? `${target}/${f.filename}` : f.filename,
        size: f.size,
      }));
      const taskId = await startTaskWorkflow(deps, req.user!, {
        title: fields.title ?? `Upload: ${files.map((f) => f.filename).join(', ')}`.slice(0, 120),
        instructions: `Add ${files.length} uploaded file(s) to ${target || '/'}`,
        type: 'upload',
        approval: 'none',
        budget: { maxTokens: 1000 },
        attachments,
      });
      res.status(201).json({ taskId, files: attachments.map((a) => a.targetPath) });
    },
  );

  return r;
}
