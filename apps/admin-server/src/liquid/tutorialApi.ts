import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { HttpError } from '../agents.js';
import { requireExtension } from '../extensions/api.js';
import { LIQUID_ID } from '../extensions/liquid.js';
import type { ExtensionService } from '../extensions/service.js';
import type { LiquidPolicyService } from '../extensions/liquidPolicy.js';
import type { LiquidProcesses } from '../extensions/liquidProcesses.js';
import type { GatewayConfigService } from '../gateway.js';
import type { KillSwitchService } from '../killswitch.js';
import type { ConfigRepoService } from './configRepo.js';
import type { PlaybookService } from './playbooks.js';
import { DD_RULE, buildDueDiligenceChange, ddCheck, DD_TITLE } from './tutorialChanges.js';

/*
 * The guided tutorial of Liquid Enterprise (ADR-0054). It fills the gaps of a click-through for an evaluator, and
 * nothing else: a demo world to start from, three whitelisted business actions that have no UI of their own, the
 * prepared due-diligence change as a person's proposal, and the Git host's reviewer login on a local install.
 * Everything else the tutorial asks for is done on the regular pages, through the regular APIs.
 */

interface Audit {
  write(e: { by: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void>;
}

export interface TutorialDeps {
  ext: ExtensionService;
  policy?: LiquidPolicyService;
  processes?: LiquidProcesses;
  playbooks?: PlaybookService;
  gateway: GatewayConfigService;
  killSwitch: KillSwitchService;
  repo?: ConfigRepoService;
  audit?: Audit;
}

/** Actions the tutorial may run for the evaluator. `agent`: played as agent sofa-lara's tool call (no model). */
export const TUTORIAL_ACTIONS: Record<string, { as: 'agent' | 'person'; fields: string[] }> = {
  cancel_purchase_order: { as: 'agent', fields: ['poId', 'reason'] },
  create_purchase_order: { as: 'person', fields: ['supplierId', 'sku', 'quantity'] },
  set_commodity_risk: { as: 'person', fields: ['sku', 'commodityRisk'] },
};
export const TUTORIAL_AGENT = 'sofa-lara';
/** The demo world: three open orders of pine beams from Nordholz (one to cancel, two to hold). */
export const DEMO_ORDERS = [
  { supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', quantity: 2000 },
  { supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', quantity: 2500 },
  { supplierId: 'S-NORDHOLZ', sku: 'BEAM-PINE-80', quantity: 3000 },
];
/** Material and supplier pairs for chapter 7, timber first; the quantity is within each supplier's limits. */
export const DD_CANDIDATES = [
  { sku: 'BEAM-PINE-80', supplier: 'S-NORDHOLZ', quantity: 2000 },
  { sku: 'BEAM-PINE-80', supplier: 'S-SILESIA', quantity: 2000 },
  { sku: 'BEAM-PINE-80', supplier: 'S-BALTIC', quantity: 2000 },
  { sku: 'FAB-OAT-01', supplier: 'S-COMO', quantity: 1000 },
  { sku: 'FAB-ANTH-02', supplier: 'S-TUCHWERK', quantity: 1000 },
  { sku: 'FOAM-HR35', supplier: 'S-FOAMTEC', quantity: 1000 },
];
const isTutorialOverlay = (o: { source?: string; reason: string }) => !!o.source?.startsWith('playbook:') || /^tutorial\b/i.test(o.reason);

const h =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) =>
    fn(req, res).catch(next);

/** Only from this machine: a Git host URL on localhost / 127.0.0.1. */
export const isLocalUrl = (u: string) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

export function tutorialRouter(d: TutorialDeps, by: (req: Request) => string): Router {
  const r = Router();
  r.use('/liquid/tutorial', requireExtension(d.ext, LIQUID_ID));

  const core = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const token = d.ext.secret(LIQUID_ID, 'ontology_internal_token');
    if (!token) throw new HttpError(503, 'liquid secret ontology_internal_token is missing');
    const res = await fetch(`${d.ext.url(LIQUID_ID, 'ontology-server')}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch((err: Error) => {
      throw new HttpError(502, `ontology server: ${err.message}`);
    });
    return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  };
  const coreOk = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const out = await core(method, path, body);
    if (out.status >= 300) throw new HttpError(502, `ontology server ${method} ${path}: ${String(out.body.error ?? out.body.result ?? out.status)}`);
    return out.body as T;
  };

  /**
   * The demo world. Back to a calm baseline (what scripts/liquid/lib.mjs calm() does for the scenarios): open playbook
   * runs cancelled and their holds released, playbook and tutorial overlays removed, erp/crm enabled, kill switches
   * normal, the policy engines on the new package. Then the company is reset and three purchase orders are placed by
   * the signed-in person. Loosening here is a person's console work like any other, audited and committed.
   */
  r.post(
    '/liquid/tutorial/prepare',
    h(async (req, res) => {
      const who = by(req);
      const done: string[] = [];
      d.repo?.beginEdit();
      try {
        for (const run of (await d.playbooks?.runs()) ?? []) {
          if (run.state !== 'running' && run.state !== 'awaiting_approval') continue;
          await d.playbooks?.cancel(run.runId, who, 'tutorial: prepare the demo world').catch(() => undefined);
          await d.processes?.release(run.runId).catch(() => undefined);
          done.push(`playbook run ${run.runId} cancelled`);
        }
        for (const o of d.policy?.listOverlays().filter(isTutorialOverlay) ?? []) {
          await d.policy?.removeOverlay(o.id);
          done.push(`overlay ${o.id} removed`);
        }
        for (const u of [...d.gateway.upstreams]) {
          if (!['erp', 'crm'].includes(u.name) || u.enabled !== false) continue;
          await d.gateway.setUpstream({ ...u, enabled: true });
          done.push(`upstream ${u.name} enabled`);
        }
        const ks = d.killSwitch.get();
        if (ks.global?.level && ks.global.level !== 'normal') {
          await d.killSwitch.setGlobal('normal', 'tutorial: prepare the demo world', who);
          done.push('global kill switch normal');
        }
        for (const [agent, e] of Object.entries(ks.agents ?? {})) {
          if (e.level === 'normal') continue;
          await d.killSwitch.setAgent(agent, 'normal', 'tutorial: prepare the demo world', who);
          done.push(`kill switch of ${agent} normal`);
        }
        if (done.length) await d.repo?.capture(who, 'tutorial: prepare the demo world');
      } finally {
        d.repo?.endEdit();
      }
      // removed overlays are gone only once gateway and core run the new package (polled every 5 s)
      const converged = d.policy ? await d.policy.waitConverged(['gateway', 'core'], 60_000) : true;
      // the tutorial starts here: what the evaluator does from now on (including these orders) counts
      const startedAt = new Date().toISOString();
      await coreOk('POST', '/internal/sim/reset', {});
      const orders: string[] = [];
      for (const o of DEMO_ORDERS) {
        const out = await core('POST', '/actions/create_purchase_order', { ...o, _requestedBy: who });
        if (out.status !== 200) throw new HttpError(502, `could not place the demo order: ${String(out.body.result ?? out.status)}`);
        orders.push((JSON.parse(String(out.body.result)) as { id: string }).id);
      }
      const last = await coreOk<{ events: Array<{ seq: number }> }>('GET', '/internal/events/query?limit=1');
      await d.audit?.write({ by: who, action: 'liquid.tutorial.prepare', target: 'demo world', details: { done, orders } });
      res.json({ startedAt, startSeq: last.events[0]?.seq ?? 0, purchaseOrders: orders, cleaned: done, converged });
    }),
  );

  /** One whitelisted business action, through the core's normal pipeline (validation, policy, event). */
  r.post(
    '/liquid/tutorial/action',
    h(async (req, res) => {
      const name = String(req.body?.action ?? '');
      const def = TUTORIAL_ACTIONS[name];
      if (!def) throw new HttpError(400, `the tutorial runs only ${Object.keys(TUTORIAL_ACTIONS).join(', ')}`);
      const raw = (req.body?.args ?? {}) as Record<string, unknown>;
      const args = Object.fromEntries(def.fields.filter((f) => raw[f] !== undefined).map((f) => [f, raw[f]]));
      // an agent's call carries the agent, no person: the evaluator can then be the second pair of eyes
      const caller = def.as === 'agent' ? { _agent: TUTORIAL_AGENT } : { _requestedBy: by(req) };
      const out = await core('POST', `/actions/${name}`, { ...args, ...caller });
      await d.audit?.write({ by: by(req), action: 'liquid.tutorial.action', target: name, details: { args, as: def.as === 'agent' ? TUTORIAL_AGENT : by(req), status: out.status } });
      res.json({ status: out.status, ok: out.status === 200, result: out.body.result, seq: out.body.seq, as: def.as === 'agent' ? TUTORIAL_AGENT : by(req) });
    }),
  );

  /** The D3 requirement as a person's proposal (the path without a model): the change plus a shadow replay as evidence. */
  r.post(
    '/liquid/tutorial/propose/due-diligence',
    h(async (req, res) => {
      if (!d.repo) throw new HttpError(503, 'the config repository is not available');
      const live = await coreOk<{ version: string; actions: Array<{ name: string; preconditions?: string[] }> }>('GET', '/internal/ontology');
      if (live.actions.find((a) => a.name === 'release_purchase_order')?.preconditions?.includes(DD_RULE)) return void res.status(409).json({ error: 'the due-diligence rule is already live', live: true });
      const open = d.repo.list({ status: 'pending' }).find((p) => p.title === DD_TITLE);
      if (open) return void res.json(open);
      const read = async (p: string) => {
        const f = await d.repo!.read(p);
        if (!('content' in f)) throw new HttpError(500, `${p} is not a file`);
        return f.content;
      };
      const changes = buildDueDiligenceChange({ schema: await read('ontology/sofa/schema.yaml'), actions: await read('ontology/sofa/actions.yaml'), roles: await read('policies/liquid/roles/data.json'), version: live.version });
      const replay = await core('POST', '/internal/shadow/precondition', { action: 'release_purchase_order', precondition: DD_RULE, check: { name: DD_RULE, ...ddCheck }, windowMs: 7 * 86_400_000, assume: { Material: { 'BEAM-PINE-80': { commodity_risk: 'high' } } } });
      const p = await d.repo.propose({
        title: DD_TITLE,
        reason: 'Purchase orders for high-risk commodities need a valid supplier due-diligence statement before release (tutorial, chapter 7).',
        evidence: replay.status === 200 ? JSON.stringify({ shadowReplay: replay.body }) : undefined,
        changes,
        author: { kind: 'person', id: by(req) },
      });
      await d.audit?.write({ by: by(req), action: 'liquid.proposal.create', target: p.id, details: { paths: p.paths, valid: p.validation.ok, tutorial: true } });
      res.status(201).json({ ...p, shadowReplay: replay.status === 200 ? replay.body : null });
    }),
  );

  /**
   * Chapter 7 needs a supplier without a valid due-diligence statement. Statements are history (events) and stay across
   * simulation resets, so a later run picks the next material and supplier that has none (timber from Nordholz first).
   */
  r.get(
    '/liquid/tutorial/due-diligence',
    h(async (_req, res) => {
      const out = await core('GET', '/objects/DueDiligenceStatement');
      const rows = out.status === 200 && Array.isArray(out.body) ? (out.body as unknown as Array<{ supplier?: string; sanctions_checked?: boolean }>) : [];
      const covered = new Set(rows.filter((x) => x.sanctions_checked === true).map((x) => String(x.supplier)));
      res.json({ candidate: DD_CANDIDATES.find((x) => !covered.has(x.supplier)) ?? null, covered: [...covered] });
    }),
  );

  /**
   * The Git host's reviewer login, so an evaluator can review and merge in the browser. Only while the Git host is bound
   * to this machine: on a shared host, reviewers have their own accounts (ADR-0054).
   */
  r.get(
    '/liquid/tutorial/git-host',
    h(async (_req, res) => {
      const url = d.ext.publicUrl(LIQUID_ID, 'forgejo') ?? 'http://localhost:3300';
      if (!isLocalUrl(url)) return void res.json({ url, user: null, password: null, reason: 'The Git host is not local: sign in with your own account.' });
      res.json({ url, user: 'reviewer', password: d.ext.secret(LIQUID_ID, 'forgejo_reviewer_password') ?? null });
    }),
  );

  return r;
}
