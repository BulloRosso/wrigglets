import { timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../agents.js';
import { requireExtension } from '../extensions/api.js';
import { LIQUID_ID } from '../extensions/liquid.js';
import type { ExtensionService } from '../extensions/service.js';
import { PlaybookError, type PlaybookService } from './playbooks.js';

/* Playbook routes (ADR-0047): console (Platform.Admin), external alerts, and the callbacks of the business worker. */

interface Audit {
  write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void>;
}

const h =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) =>
    fn(req, res).catch((err: unknown) => next(err instanceof PlaybookError ? new HttpError(err.status, err.message) : err));

const alertBody = z
  .object({
    source: z.string().min(1).max(80),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string().max(500).default(''),
    upstream: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional(),
    agent: z.string().max(40).optional(),
    reference: z.string().max(300).optional(),
  })
  .catchall(z.union([z.string().max(500), z.number(), z.boolean()]));

export function playbooksRouter(ext: ExtensionService, svc: PlaybookService, by: (req: Request) => string, audit?: Audit): Router {
  const r = Router();
  r.use('/liquid/playbooks', requireExtension(ext, LIQUID_ID));
  r.get('/liquid/playbooks', h(async (_req, res) => res.json(await svc.load())));
  r.get('/liquid/playbooks/runs', h(async (_req, res) => res.json(await svc.runs())));
  r.post(
    '/liquid/playbooks/runs/:runId/steps/:stepId/decide',
    h(async (req, res) => {
      const decision = req.body?.decision;
      if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'decision must be approve or reject');
      const comment = typeof req.body?.comment === 'string' ? req.body.comment.slice(0, 1000) : undefined;
      const s = await svc.decide(String(req.params.runId), String(req.params.stepId), decision, by(req), comment);
      await audit?.write({ by: by(req), action: `playbook.step.${decision}`, target: String(req.params.runId), details: { step: req.params.stepId, comment } });
      res.json(s);
    }),
  );
  r.post(
    '/liquid/playbooks/runs/:runId/cancel',
    h(async (req, res) => {
      await svc.cancel(String(req.params.runId), by(req), typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined);
      await audit?.write({ by: by(req), action: 'playbook.run.cancel', target: String(req.params.runId) });
      res.status(202).json({ ok: true });
    }),
  );
  /** Test alert from the console (e.g. to rehearse a playbook); the same path as external alerts. */
  r.post(
    '/liquid/playbooks/alerts',
    h(async (req, res) => {
      const a = alertBody.parse(req.body ?? {});
      const out = await svc.sense({ kind: 'alert', data: a }, by(req));
      await audit?.write({ by: by(req), action: 'playbook.alert', target: a.source, details: { severity: a.severity, runs: out.runs.length } });
      res.status(202).json(out);
    }),
  );
  return r;
}

const bearerOk = (req: Request, want: string | undefined) => {
  const got = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return !!want && Buffer.byteLength(got) === Buffer.byteLength(want) && timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

export function playbooksInternalRouter(ext: ExtensionService, svc: PlaybookService): Router {
  const r = Router();
  const auth =
    (secret: string): RequestHandler =>
    (req, res, next) => {
      if (!ext.isInstalled(LIQUID_ID) || !bearerOk(req, ext.secret(LIQUID_ID, secret))) return void res.status(401).json({ error: 'unauthorized' });
      next();
    };
  /** External alerts (e.g. a vulnerability feed): POST /internal/alerts, bearer = the extension's alerts_token. */
  r.post(
    '/alerts',
    auth('alerts_token'),
    express.json({ limit: '64kb' }),
    h(async (req, res) => res.status(202).json(await svc.sense({ kind: 'alert', data: alertBody.parse(req.body ?? {}) }, 'alert'))),
  );
  const json = express.json({ limit: '2mb' });
  r.post('/liquid/playbooks/assess', auth('playbook_token'), json, h(async (req, res) => res.json(await svc.assess((req.body?.trigger ?? {}) as Record<string, unknown>))));
  r.post('/liquid/playbooks/execute', auth('playbook_token'), json, h(async (req, res) => res.json(await svc.execute(req.body))));
  r.post(
    '/liquid/playbooks/record',
    auth('playbook_token'),
    json,
    h(async (req, res) => {
      await svc.record(req.body);
      res.json({ ok: true });
    }),
  );
  return r;
}
