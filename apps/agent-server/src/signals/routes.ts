import express, { Router, type Express, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { expectationEditBody, expectationResolveBody, interpretResult, observationBody, type ExpectationState } from '@cw/shared';
import { dismissExpectationUpdate, editExpectationUpdate, fulfillExpectationUpdate } from '@cw/signals';
import { HttpError } from '../api/context.js';
import { SignalsAiError, SignalsDisabledError, SignalsInputError, SignalsLimitError, type SignalsService } from './service.js';

/*
 * HTTP surface of Signals on the agent (ADR-0037).
 *   /internal/signals/*  control plane only (forwards observations from the signals hub and the hub's MCP tools)
 *   /api/signals/*       people with a role for this agent: open loops, observations, playground
 */

const wrap = (fn: (req: Request, res: express.Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res).catch((err) => {
    if (err instanceof SignalsDisabledError) return next(new HttpError(409, err.message));
    if (err instanceof SignalsLimitError) return next(new HttpError(429, err.message));
    if (err instanceof SignalsAiError) return next(new HttpError(409, err.message));
    if (err instanceof SignalsInputError) return next(new HttpError(400, err.message));
    next(err);
  });
};

const internalObserveBody = observationBody.extend({ by: z.string().trim().min(1).max(200).default('signals-hub') });
const internalResolveBody = expectationResolveBody.extend({ by: z.string().trim().min(1).max(200) });
const listQuery = z.object({ status: z.enum(['open', 'closed', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(500).default(100) });
const interpretBody = z.object({ observation: observationBody, brief: z.string().max(4000).optional() });
const commitBody = z.object({ observation: observationBody, result: interpretResult });

async function assertRunning(signals: SignalsService, id: string) {
  const d = await signals.handle(id).describe();
  if (d.status.name !== 'RUNNING') throw new HttpError(409, 'The expectation is already closed');
}

/** Machine-to-machine routes, protected by the control plane token (same middleware as AGENTS.md editing). */
export function mountSignalsInternal(app: Express, signals: SignalsService, controlPlane: RequestHandler) {
  app.post(
    '/internal/signals/observe',
    controlPlane,
    express.json({ limit: '128kb' }),
    wrap(async (req, res) => {
      const { by, ...o } = internalObserveBody.parse(req.body);
      const r = await signals.observe(o, by);
      res.status(r.duplicate ? 200 : 202).json(r);
    }),
  );
  app.get(
    '/internal/signals/expectations',
    controlPlane,
    wrap(async (_req, res) => {
      await signals.requireEnabled();
      res.json(await signals.listOpen());
    }),
  );
  app.post(
    '/internal/signals/expectations/:id/fulfill',
    controlPlane,
    express.json({ limit: '16kb' }),
    wrap(async (req, res) => {
      await signals.requireEnabled();
      const id = String(req.params.id);
      const body = internalResolveBody.parse(req.body);
      await assertRunning(signals, id);
      const st = await signals.handle(id).executeUpdate(fulfillExpectationUpdate, { args: [{ by: body.by, reason: body.reason }] });
      res.json({ id: st.id, state: st.state });
    }),
  );
}

export function signalsRouter(signals: SignalsService, audit: { write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void> }): Router {
  const r = Router();
  const playgroundLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 60,
    keyGenerator: (req) => (req as Request).user?.upn ?? 'anonymous',
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many interpretations, try again later' },
  });

  r.get(
    '/signals',
    wrap(async (_req, res) => {
      const cfg = await signals.getConfig();
      res.json({ enabled: cfg.enabled, brief: cfg.brief, defaultAction: cfg.defaultAction, fulfilThreshold: cfg.fulfilThreshold, graceDays: cfg.graceDays, owner: cfg.owner });
    }),
  );
  r.get(
    '/signals/expectations',
    wrap(async (req, res) => {
      const { status, limit } = listQuery.parse(req.query);
      res.json(await signals.list(status, limit));
    }),
  );
  r.get(
    '/signals/expectations/:id',
    wrap(async (req, res) => {
      res.json(await signals.state(String(req.params.id)));
    }),
  );

  const change = (kind: 'edit' | 'dismiss' | 'fulfill') =>
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const by = req.user!.upn;
      await assertRunning(signals, id);
      const h = signals.handle(id);
      let st: ExpectationState;
      let text: string;
      if (kind === 'edit') {
        const body = expectationEditBody.parse(req.body);
        st = await h.executeUpdate(editExpectationUpdate, { args: [{ ...body, by }] });
        text = Object.entries(body)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k} → ${String(v).slice(0, 120)}`)
          .join('; ');
      } else {
        const { reason } = expectationResolveBody.parse(req.body);
        st = await h.executeUpdate(kind === 'dismiss' ? dismissExpectationUpdate : fulfillExpectationUpdate, { args: [{ by, reason }] });
        text = reason;
      }
      // Corrections teach the interpreter (shown as examples in later interpretations)
      await signals.recordCorrection({ by, expectationId: id, kind: kind === 'edit' ? 'edited' : kind === 'dismiss' ? 'dismissed' : 'fulfilled', title: st.title, text });
      await audit.write({ by, action: `signals.expectation.${kind}`, target: id, details: { title: st.title, text: text.slice(0, 300) } });
      res.json(st);
    });
  r.post('/signals/expectations/:id/edit', change('edit'));
  r.post('/signals/expectations/:id/dismiss', change('dismiss'));
  r.post('/signals/expectations/:id/fulfill', change('fulfill'));

  r.get(
    '/signals/observations',
    wrap(async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
      res.json(await signals.store.observations(limit));
    }),
  );

  /** Playground: interpret without persisting anything (the person reviews and may edit the result before committing). */
  r.post(
    '/signals/interpret',
    playgroundLimiter,
    wrap(async (req, res) => {
      const { observation, brief } = interpretBody.parse(req.body);
      const open = await signals.listOpen();
      const out = await signals.interpret(observation, open, { brief });
      await audit.write({ by: req.user!.upn, action: 'signals.interpret', target: 'playground', details: { subject: observation.subject?.slice(0, 120), events: out.events.length, expectations: out.expectations.length, costUsd: out.costUsd } });
      res.json({ ...out, open: open.length });
    }),
  );
  r.post(
    '/signals/commit',
    wrap(async (req, res) => {
      const { observation, result } = commitBody.parse(req.body);
      const r2 = await signals.observe({ ...observation, source: 'playground' }, req.user!.upn, { preInterpreted: result });
      res.status(r2.duplicate ? 200 : 202).json(r2);
    }),
  );
  return r;
}
