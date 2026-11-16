import { timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { diffIr, type OntologyIr } from '@cw/ontology-ir';
import { HttpError } from '../agents.js';
import { requireExtension } from '../extensions/api.js';
import { LIQUID_ID } from '../extensions/liquid.js';
import type { ExtensionService } from '../extensions/service.js';
import { configRpc } from './configMcp.js';
import { ConfigError, type ConfigRepoService, type Validators } from './configRepo.js';
import { DraftError, type DraftStore } from './drafts.js';

/*
 * Admin console routes of the config repository, proposals and ontology drafts (ADR-0046), the commit-on-edit hook,
 * and the machine endpoint of the "config" MCP upstream.
 */

interface Audit {
  write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void>;
}

export interface LiquidConfigDeps {
  repo: ConfigRepoService;
  drafts: DraftStore;
  validators: Validators;
  audit?: Audit;
  logger?: { warn(o: object, msg: string): void };
}

const asHttp = (err: unknown) => (err instanceof ConfigError || err instanceof DraftError ? new HttpError(err.status, err.message) : err);
const h =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) =>
    fn(req, res).catch((err: unknown) => next(asHttp(err)));
const str = (v: unknown, max = 4000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Console edits of the stores become commits on main (author = signed-in admin) while Liquid is installed. */
const CAPTURE = /^\/(gateway\/upstreams|agents(\/[^/]+(\/(tools|ai|entra))?)?|safety\/rules|liquid\/policy\/overlays)(\/|$)/;
export function captureEdits(ext: ExtensionService, repo: ConfigRepoService, by: (req: Request) => string, logger?: LiquidConfigDeps['logger']): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && CAPTURE.test(req.path)) {
      res.on('finish', () => {
        if (res.statusCode >= 400 || !ext.isInstalled(LIQUID_ID)) return;
        void repo.capture(by(req), `${req.method} /api${req.path}`).catch((err: Error) => logger?.warn({ err: err.message, path: req.path }, 'config repository: capture failed'));
      });
    }
    next();
  };
}

export function liquidConfigRouter(ext: ExtensionService, d: LiquidConfigDeps, by: (req: Request) => string): Router {
  const r = Router();
  const person = (req: Request) => ({ email: by(req), roles: (req as Request & { user?: { roles?: string[] } }).user?.roles ?? [] });
  r.use('/liquid/config', requireExtension(ext, LIQUID_ID));
  r.use('/liquid/proposals', requireExtension(ext, LIQUID_ID));
  r.use('/liquid/ontology/drafts', requireExtension(ext, LIQUID_ID));

  r.get('/liquid/config', h(async (_req, res) => res.json({ ...(await d.repo.status()), drift: await d.repo.drift() })));
  r.get('/liquid/config/file', h(async (req, res) => res.json(await d.repo.read(str(req.query.path, 300), str(req.query.rev, 200) ?? 'main'))));
  r.post(
    '/liquid/config/reconcile',
    h(async (req, res) => {
      const out = await d.repo.reconcile(by(req), true);
      await d.audit?.write({ by: by(req), action: 'liquid.config.reconcile', target: 'main', details: { ok: out.ok } });
      res.json(out);
    }),
  );

  r.get('/liquid/proposals', h(async (req, res) => res.json(d.repo.list({ status: str(req.query.status, 20) as never }))));
  r.get('/liquid/proposals/:id', h(async (req, res) => res.json(await d.repo.get(String(req.params.id)))));
  r.post(
    '/liquid/proposals',
    h(async (req, res) => {
      const changes = Array.isArray(req.body?.changes) ? (req.body.changes as Array<{ path?: unknown; content?: unknown }>).map((c) => ({ path: String(c.path ?? ''), content: c.content === null ? null : String(c.content ?? '') })) : [];
      const p = await d.repo.propose({ title: String(req.body?.title ?? ''), reason: String(req.body?.reason ?? ''), evidence: str(req.body?.evidence), changes, author: { kind: 'person', id: by(req) } });
      await d.audit?.write({ by: by(req), action: 'liquid.proposal.create', target: p.id, details: { paths: p.paths, valid: p.validation.ok } });
      res.status(201).json(p);
    }),
  );
  /** The ontology as the proposal would make it (compiled), for the diff graph; null when it does not touch the ontology. */
  r.get(
    '/liquid/proposals/:id/ir',
    h(async (req, res) => {
      const p = await d.repo.get(String(req.params.id));
      const domain = p.paths.find((x) => x.startsWith('ontology/'))?.split('/')[1];
      if (!domain || !d.validators.compileOntology) return void res.json(null);
      const f = await d.repo.git.files(p.head, `ontology/${domain}/`);
      const out = await d.validators.compileOntology({ 'schema.yaml': f[`ontology/${domain}/schema.yaml`] ?? '', 'actions.yaml': f[`ontology/${domain}/actions.yaml`] ?? '', 'bindings.yaml': f[`ontology/${domain}/bindings.yaml`] ?? '' });
      res.json(out.ok ? out.ir : null);
    }),
  );
  r.post('/liquid/proposals/:id/revalidate', h(async (req, res) => res.json(await d.repo.revalidate(String(req.params.id)))));
  r.post(
    '/liquid/proposals/:id/decide',
    h(async (req, res) => {
      const decision = req.body?.decision;
      if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'decision must be approve or reject');
      const p = await d.repo.decide(String(req.params.id), decision, person(req), str(req.body?.comment, 2000));
      await d.audit?.write({ by: by(req), action: `liquid.proposal.${decision}`, target: p.id, details: { paths: p.paths, mergedAs: p.mergedAs, comment: p.comment } });
      res.json(p);
    }),
  );

  /* -------------------------------------------------------------------------------- ontology drafts (E2) */
  const compile = async (files: Record<string, string>) => {
    if (!d.validators.compileOntology) throw new HttpError(503, 'the ontology compiler service is not available');
    return d.validators.compileOntology(files);
  };
  r.get('/liquid/ontology/drafts', h(async (req, res) => res.json((await d.drafts.list(by(req))).map(({ files: _f, ...x }) => x))));
  r.post(
    '/liquid/ontology/drafts',
    h(async (req, res) => {
      const domain = str(req.body?.domain, 40) ?? 'sofa';
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(domain)) throw new HttpError(400, 'bad domain');
      const base = await d.repo.git.rev('main');
      if (!base) throw new HttpError(409, 'the config repository is not initialised');
      const f = await d.repo.git.files(base, `ontology/${domain}/`);
      const pick = (n: string) => {
        const t = f[`ontology/${domain}/${n}`];
        if (t === undefined) throw new HttpError(404, `ontology/${domain}/${n} is missing`);
        return t;
      };
      res.status(201).json(await d.drafts.create({ domain, base, files: { 'schema.yaml': pick('schema.yaml'), 'actions.yaml': pick('actions.yaml'), 'bindings.yaml': pick('bindings.yaml') }, by: by(req) }));
    }),
  );
  r.get('/liquid/ontology/drafts/:id', h(async (req, res) => res.json(await d.drafts.get(String(req.params.id)))));
  r.delete(
    '/liquid/ontology/drafts/:id',
    h(async (req, res) => {
      await d.drafts.remove(String(req.params.id));
      res.status(204).end();
    }),
  );
  r.post('/liquid/ontology/drafts/:id/ops', h(async (req, res) => res.json(await d.drafts.apply(String(req.params.id), Array.isArray(req.body?.ops) ? req.body.ops : []))));
  r.post(
    '/liquid/ontology/drafts/:id/validate',
    h(async (req, res) => {
      const dr = await d.drafts.get(String(req.params.id));
      const after = await compile(dr.files);
      let diff;
      if (after.ok && after.ir) {
        const baseFiles = await d.repo.git.files(dr.base, `ontology/${dr.domain}/`);
        const before = await compile({ 'schema.yaml': baseFiles[`ontology/${dr.domain}/schema.yaml`] ?? '', 'actions.yaml': baseFiles[`ontology/${dr.domain}/actions.yaml`] ?? '', 'bindings.yaml': baseFiles[`ontology/${dr.domain}/bindings.yaml`] ?? '' }).catch(() => undefined);
        if (before?.ir) diff = diffIr(before.ir as OntologyIr, after.ir);
      }
      res.json({ ok: after.ok, errors: after.errors ?? [], ir: after.ir, diff });
    }),
  );
  r.post(
    '/liquid/ontology/drafts/:id/submit',
    h(async (req, res) => {
      const dr = await d.drafts.get(String(req.params.id));
      if (dr.proposal) throw new HttpError(409, `already submitted as ${dr.proposal}`);
      if (!dr.ops.length) throw new HttpError(422, 'the draft has no changes');
      const p = await d.repo.propose({
        title: str(req.body?.title, 140) ?? `Ontology ${dr.domain}: ${dr.ops.length} change(s)`,
        reason: str(req.body?.reason) ?? 'Edited in the ontology editor',
        evidence: `Draft ${dr.id}, operations:\n${dr.ops.map((o) => JSON.stringify(o)).join('\n')}`,
        changes: (['schema.yaml', 'actions.yaml', 'bindings.yaml'] as const).map((n) => ({ path: `ontology/${dr.domain}/${n}`, content: dr.files[n] })),
        author: { kind: 'person', id: by(req) },
      });
      dr.proposal = p.id;
      await d.drafts.save(dr);
      await d.audit?.write({ by: by(req), action: 'liquid.proposal.create', target: p.id, details: { draft: dr.id, paths: p.paths, valid: p.validation.ok } });
      res.status(201).json(p);
    }),
  );
  return r;
}

/** POST /internal/liquid/config/mcp — the gateway's upstream "config" (bearer = the extension's config_mcp_token). */
export function liquidConfigInternalRouter(ext: ExtensionService, repo: ConfigRepoService, audit?: Audit): Router {
  const r = Router();
  const auth: RequestHandler = (req, res, next) => {
    const want = ext.secret(LIQUID_ID, 'config_mcp_token');
    const got = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const ok = !!want && Buffer.byteLength(got) === Buffer.byteLength(want) && timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!ok || !ext.isInstalled(LIQUID_ID)) return void res.status(401).json({ error: 'unauthorized' });
    next();
  };
  r.post(
    '/liquid/config/mcp',
    auth,
    express.json({ limit: '2mb' }),
    h(async (req, res) => {
      const onProposal = (id: string, agent: string) => void audit?.write({ by: agent, action: 'liquid.proposal.create', target: id });
      const msgs = Array.isArray(req.body) ? req.body : [req.body];
      const out = (await Promise.all(msgs.map((m) => configRpc(repo, m, onProposal)))).filter((x) => x !== undefined);
      if (!out.length) return void res.status(202).end();
      res.json(Array.isArray(req.body) ? out : out[0]);
    }),
  );
  return r;
}
