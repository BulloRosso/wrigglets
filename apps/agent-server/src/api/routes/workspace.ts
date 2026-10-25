import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { StagingFile, WorkspaceEntry } from '@cw/shared';
import { isProtectedPath, resolveWorkspacePath } from '../../workspace/paths.js';
import { HttpError, type ApiDeps } from '../context.js';
import { startTaskWorkflow } from './tasks.js';

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

  r.get('/workspace/commits', async (req, res) => {
    const p = req.query.path ? (await resolveWorkspacePath(config.workspaceDir, String(req.query.path), { mustExist: false })).rel : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json(await git.log({ path: p, limit, files: true, grep: req.query.taskId ? `Task-Id: ${String(req.query.taskId)}` : undefined }));
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
      filename: (_req, file, cb) => cb(null, path.basename(file.originalname).replace(/[^\w.\- ()]/g, '_')),
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
