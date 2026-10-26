import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SecretStore } from '@cw/secrets';
import {
  AVATAR_MOODS,
  agentEntra,
  DEFAULT_GUARD_CONFIG,
  DEFAULT_GUARD_SYSTEM_PROMPT,
  guardConfig,
  safetyRules,
  securityWarningBody,
  setKillSwitchBody,
  upstreamServer,
  type AgentSummary,
  type AvatarMood,
  type ToolCallAuditEntry,
} from '@cw/shared';
import { HttpError } from './agents.js';
import type { AvatarService } from './avatars.js';
import type { Config } from './config.js';
import type { GatewayConfigService } from './gateway.js';
import type { KillSwitchService } from './killswitch.js';
import type { LiteLLMService } from './litellm.js';
import { approvalMailHtml, notifyMailBody, type MailService } from './mail.js';
import type { OAuthAdmin } from './oauthAdmin.js';
import type { AdminAudit, AgentRegistry } from './registry.js';
import type { SafetyRuleEngine } from './safety.js';
import type { SecurityGuardService } from './security.js';

export interface ExtensionDeps {
  config: Config;
  registry: AgentRegistry;
  audit: AdminAudit;
  avatars: AvatarService;
  killSwitch: KillSwitchService;
  gateway: GatewayConfigService;
  safety: SafetyRuleEngine;
  guard: SecurityGuardService;
  secrets?: SecretStore;
  mail: MailService;
  ai: LiteLLMService;
  spendLimit: (spec: AgentSummary['spec']) => number;
  agents: Pick<import('./agents.js').AgentService, 'update' | 'rotateAiKey' | 'aiModels' | 'setEntra' | 'syncAiKeys'>;
  smallModel: string;
  oauth: Pick<OAuthAdmin, 'users'>;
}

const SECRET_NAME = /^[0-9a-zA-Z-]{1,127}$/;
const isMood = (m: string): m is AvatarMood => (AVATAR_MOODS as readonly string[]).includes(m);
const bearer = (req: Request) => req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function sendImage(res: Response, file: string, version?: string) {
  if (!existsSync(file)) {
    res.status(404).json({ error: 'no image' });
    return;
  }
  const s = await stat(file);
  const etag = `"${version ?? s.mtimeMs}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=60');
  if (res.req.header('if-none-match') === etag) {
    res.status(304).end();
    return;
  }
  res.type('image/png');
  createReadStream(file).pipe(res);
}

/** Adds kill-switch state and portrait version to agent summaries. */
export function enrich(d: ExtensionDeps, s: AgentSummary): AgentSummary {
  return { ...s, killSwitch: d.killSwitch.effective(s.spec.agentId), avatarVersion: undefined };
}

export async function enrichAsync(d: ExtensionDeps, s: AgentSummary): Promise<AgentSummary> {
  const meta = await d.avatars.meta(s.spec.agentId);
  return { ...enrich(d, s), avatarVersion: meta?.moods.neutral?.generatedAt };
}

/** Routes for the admin console (mounted behind Platform.Admin authorization). */
export function extensionRouter(d: ExtensionDeps, by: (req: Request) => string): Router {
  const r = Router();

  /* ------------------------------------------------------------ kill switch */
  r.get('/killswitch', (_req, res) => {
    res.json({
      state: d.killSwitch.get(),
      effective: Object.fromEntries(d.registry.list().map((a) => [a.agentId, d.killSwitch.effective(a.agentId)])),
    });
  });
  r.put('/killswitch', async (req, res) => {
    const body = setKillSwitchBody.parse(req.body);
    await d.killSwitch.setGlobal(body.level, body.reason, by(req));
    if (body.level === 'normal') for (const a of d.registry.list()) d.safety.snooze(a.agentId);
    res.json(d.killSwitch.get());
  });
  r.put('/agents/:id/killswitch', async (req, res) => {
    if (!d.registry.get(req.params.id)) throw new HttpError(404, 'agent not found');
    const body = setKillSwitchBody.parse(req.body);
    await d.killSwitch.setAgent(req.params.id, body.level, body.reason, by(req));
    if (body.level === 'normal') d.safety.snooze(req.params.id);
    res.json(d.killSwitch.effective(req.params.id));
  });

  /* ------------------------------------------------------------ safety rules */
  r.get('/safety/rules', (_req, res) => res.json({ rules: d.safety.get(), lastRun: d.safety.lastRun, observations: d.safety.last }));
  r.put('/safety/rules', async (req, res) => {
    await d.safety.save(safetyRules.parse(req.body?.rules));
    await d.audit.write({ by: by(req), action: 'safety.rules', target: '*', details: { rules: d.safety.get().map((x) => `${x.id}:${x.enabled ? x.threshold : 'off'}`) } });
    res.json({ rules: d.safety.get() });
  });
  r.post('/safety/run', async (_req, res) => res.json({ observations: await d.safety.run(), lastRun: d.safety.lastRun }));

  /* ------------------------------------------------------------ exfiltration guard (ADR-0033) */
  r.get('/security/guard', (_req, res) =>
    res.json({ config: d.guard.getConfig(), defaultSystemPrompt: DEFAULT_GUARD_SYSTEM_PROMPT, defaults: DEFAULT_GUARD_CONFIG, platformModel: d.smallModel }),
  );
  r.put('/security/guard', async (req, res) => {
    const before = d.guard.getConfig().model;
    const next = guardConfig.parse(req.body?.config);
    if (next.model) {
      const ai = await d.ai.status();
      if (ai.reachable && !ai.models.some((m) => m.name === next.model)) throw new HttpError(400, `Model "${next.model}" is not configured in the AI gateway (LiteLLM).`);
    }
    const config = await d.guard.setConfig(next, by(req));
    // the agents' virtual keys may only use the models they are given
    if (config.model !== before) await d.agents.syncAiKeys();
    res.json({ config });
  });
  r.get('/security/alerts', (req, res) => {
    const status = req.query.status === 'open' || req.query.status === 'acknowledged' ? req.query.status : undefined;
    res.json({ open: d.guard.openCount(), alerts: d.guard.list(status).slice(0, 200) });
  });
  r.post('/security/alerts/:id/acknowledge', async (req, res) => {
    const note = z.object({ note: z.string().max(1000).optional() }).parse(req.body ?? {}).note;
    const alert = await d.guard.acknowledge(req.params.id, by(req), note);
    if (!alert) throw new HttpError(404, 'alert not found');
    res.json(alert);
  });

  /* ------------------------------------------------------------ MCP gateway */
  r.get('/gateway', async (_req, res) => {
    const [health, tools] = await Promise.all([
      fetch(`${d.config.MCP_GATEWAY_URL}/health`, { signal: AbortSignal.timeout(2000) })
        .then(async (x) => (await x.json()) as Record<string, unknown>)
        .catch(() => ({ status: 'down' })),
      d.gateway.gatewayCall<Array<{ name: string; description?: string }>>('/internal/tools'),
    ]);
    res.json({ health, upstreams: d.gateway.upstreams, tools: tools ?? [] });
  });
  r.put('/gateway/upstreams/:name', async (req, res) => {
    const u = upstreamServer.parse({ ...req.body, name: req.params.name });
    await d.gateway.setUpstream(u);
    await d.audit.write({ by: by(req), action: 'gateway.upstream', target: u.name, details: { url: u.url, headers: Object.keys(u.headers) } });
    res.json(u);
  });
  r.delete('/gateway/upstreams/:name', async (req, res) => {
    await d.gateway.deleteUpstream(req.params.name);
    await d.audit.write({ by: by(req), action: 'gateway.upstream.delete', target: req.params.name });
    res.status(204).end();
  });
  r.get('/agents/:id/tools', (req, res) => res.json({ allowedTools: d.gateway.allowedTools(req.params.id) }));
  r.put('/agents/:id/tools', async (req, res) => {
    if (!d.registry.get(req.params.id)) throw new HttpError(404, 'agent not found');
    const { allowedTools } = z.object({ allowedTools: z.array(z.string().regex(/^[a-z0-9_*-]{1,100}$/)).max(100) }).parse(req.body);
    await d.gateway.setAllowedTools(req.params.id, allowedTools);
    await d.audit.write({ by: by(req), action: 'gateway.allow', target: req.params.id, details: { allowedTools } });
    res.json({ allowedTools });
  });
  r.get('/agents/:id/tool-calls', async (req, res) => {
    res.json((await d.gateway.gatewayCall<ToolCallAuditEntry[]>(`/internal/audit?agentId=${encodeURIComponent(req.params.id)}&limit=100`)) ?? []);
  });

  /* ------------------------------------------------------------ Key Vault secrets (values write-only) */
  r.get('/secrets', async (_req, res) => {
    if (!d.secrets) return res.json({ enabled: false, secrets: [] });
    res.json({ enabled: true, vaultUrl: process.env.KEYVAULT_URL, secrets: await d.secrets.list() });
  });
  r.put('/secrets/:name', async (req, res) => {
    if (!d.secrets) throw new HttpError(409, 'No Key Vault configured');
    if (!SECRET_NAME.test(req.params.name)) throw new HttpError(400, 'Secret names: 1–127 letters, digits and dashes');
    const { value, contentType } = z.object({ value: z.string().min(1).max(25_000), contentType: z.string().max(100).optional() }).parse(req.body);
    await d.secrets.set(req.params.name, value, { contentType, tags: { setBy: by(req) } });
    await d.audit.write({ by: by(req), action: 'secret.set', target: req.params.name });
    res.status(204).end();
  });
  r.delete('/secrets/:name', async (req, res) => {
    if (!d.secrets) throw new HttpError(409, 'No Key Vault configured');
    await d.secrets.remove(req.params.name);
    await d.audit.write({ by: by(req), action: 'secret.delete', target: req.params.name });
    res.status(204).end();
  });

  /* ------------------------------------------------------------ portraits */
  r.get('/avatars/reference', async (_req, res) => {
    const p = d.avatars.referencePath();
    if (!p) throw new HttpError(404, 'no reference image');
    res.setHeader('x-custom-reference', String(d.avatars.isCustomReference()));
    await sendImage(res, p);
  });
  r.put('/avatars/reference', express.raw({ type: ['image/png', 'application/octet-stream'], limit: '10mb' }), async (req, res) => {
    await d.avatars.setReference(req.body as Buffer);
    await d.audit.write({ by: by(req), action: 'avatar.reference', target: '*' });
    res.status(204).end();
  });
  r.delete('/avatars/reference', async (req, res) => {
    await d.avatars.resetReference();
    await d.audit.write({ by: by(req), action: 'avatar.reference.reset', target: '*' });
    res.status(204).end();
  });
  r.get('/agents/:id/avatar', async (req, res) => res.json(await d.avatars.status(req.params.id)));
  r.post('/agents/:id/avatar', async (req, res) => {
    const entry = d.registry.get(req.params.id);
    if (!entry) throw new HttpError(404, 'agent not found');
    const body = z.object({ prompt: z.string().trim().min(3).max(2000).optional(), moods: z.array(z.enum(AVATAR_MOODS)).min(1).optional() }).parse(req.body ?? {});
    const prompt = body.prompt ?? entry.spec.avatarPrompt;
    if (!prompt) throw new HttpError(400, 'A prompt is required');
    if (body.prompt && body.prompt !== entry.spec.avatarPrompt) await d.registry.put({ ...entry.spec, avatarPrompt: body.prompt, updatedAt: new Date().toISOString() }, entry.secrets);
    const job = d.avatars.start(req.params.id, prompt, by(req), body.moods);
    await d.audit.write({ by: by(req), action: 'avatar.generate', target: req.params.id, details: { moods: body.moods ?? 'all' } });
    res.status(202).json(job);
  });
  r.get('/agents/:id/avatar/:mood', async (req, res) => {
    if (!isMood(req.params.mood)) throw new HttpError(404, 'unknown mood');
    const meta = await d.avatars.meta(req.params.id);
    await sendImage(res, d.avatars.imagePath(req.params.id, req.params.mood), meta?.moods[req.params.mood]?.generatedAt);
  });

  /* ------------------------------------------------------------ mail outbox (human in the loop, ADR-0026) */
  /* ------------------------------------------------------------ AI gateway, prices and spend (ADR-0029) */
  r.get('/ai', async (req, res) => {
    const status = await d.ai.status(req.query.refresh === '1');
    const agents = await Promise.all(d.registry.list().map((spec) => d.ai.agentSpend(spec, d.registry.get(spec.agentId)?.secrets.aiKey, d.spendLimit(spec))));
    res.json({ status, agents });
  });
  /** AI & budget of one agent: spend, daily history and its LiteLLM key — managed here, not in the LiteLLM UI. */
  r.get('/agents/:id/ai', async (req, res) => {
    const entry = d.registry.get(req.params.id);
    if (!entry) throw new HttpError(404, 'agent not found');
    const key = entry.secrets.aiKey;
    const [spend, info, daily] = await Promise.all([
      d.ai.agentSpend(entry.spec, key, d.spendLimit(entry.spec)),
      key ? d.ai.keyInfo(key).then((k) => ({ key: k }), (err: unknown) => ({ keyError: String(err instanceof Error ? err.message : err).slice(0, 200) })) : Promise.resolve({ keyError: 'no key provisioned yet' }),
      key ? d.ai.dailySpend(key).catch(() => []) : Promise.resolve([]),
    ]);
    res.json({ spend, ...info, daily, smallModel: d.smallModel });
  });
  r.put('/agents/:id/ai', async (req, res) => {
    if (!d.registry.get(req.params.id)) throw new HttpError(404, 'agent not found');
    const body = z.object({ spendLimitUsd: z.number().min(0.5).max(10_000).optional(), model: z.string().trim().min(1).max(120).optional() }).parse(req.body);
    const before = d.registry.get(req.params.id)!.spec;
    await d.agents.update(req.params.id, body);
    await d.audit.write({ by: by(req), action: 'agent.ai', target: req.params.id, details: { spendLimitUsd: body.spendLimitUsd, model: body.model, previousModel: before.model, previousLimit: before.spendLimitUsd } });
    res.json({ ok: true, redeployed: body.model !== undefined && body.model !== before.model });
  });
  /* ------------------------------------------------------------ Entra OBO identity (optional capability) */
  r.get('/entra', (_req, res) => res.json({ available: !!d.config.ENTRA_TENANT_ID, tenantId: d.config.ENTRA_TENANT_ID ?? null }));
  r.get('/agents/:id/entra', (req, res) => {
    const entry = d.registry.get(req.params.id);
    if (!entry) throw new HttpError(404, 'agent not found');
    res.json({ available: !!d.config.ENTRA_TENANT_ID, entra: entry.spec.entra ?? null });
  });
  r.put('/agents/:id/entra', async (req, res) => {
    if (!d.registry.get(req.params.id)) throw new HttpError(404, 'agent not found');
    const entra = agentEntra.nullable().parse(req.body?.entra ?? null) ?? undefined;
    await d.agents.setEntra(req.params.id, entra);
    void d.gateway.push();
    // credential references and ids only — never secret values
    await d.audit.write({
      by: by(req),
      action: 'agent.entra',
      target: req.params.id,
      details: entra ? { enabled: entra.enabled, clientId: entra.clientId, tenantId: entra.tenantId, credentialKind: entra.credential.kind, allowAgentOnly: entra.allowAgentOnly } : { removed: true },
    });
    res.json({ ok: true });
  });
  r.post('/agents/:id/ai/rotate', async (req, res) => {
    await d.agents.rotateAiKey(req.params.id);
    await d.audit.write({ by: by(req), action: 'agent.ai.rotate', target: req.params.id });
    res.json({ ok: true });
  });
  r.post('/agents/:id/ai/block', async (req, res) => {
    const entry = d.registry.get(req.params.id);
    if (!entry?.secrets.aiKey) throw new HttpError(404, 'agent or key not found');
    const { blocked } = z.object({ blocked: z.boolean() }).parse(req.body);
    await d.ai.setBlocked(entry.secrets.aiKey, blocked);
    await d.audit.write({ by: by(req), action: blocked ? 'agent.ai.block' : 'agent.ai.unblock', target: req.params.id });
    res.json({ ok: true, blocked });
  });

  r.get('/agents/:id/spend', async (req, res) => {
    const entry = d.registry.get(req.params.id);
    if (!entry) throw new HttpError(404, 'agent not found');
    res.json(await d.ai.agentSpend(entry.spec, entry.secrets.aiKey, d.spendLimit(entry.spec)));
  });

  r.get('/mail', async (req, res) => {
    const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
    const all = await d.mail.list(500);
    res.json({ delivery: d.mail.delivery, mails: agentId ? all.filter((m) => m.agentId === agentId) : all });
  });
  r.get('/mail/:id/html', async (req, res) => {
    const html = await d.mail.html(req.params.id);
    if (!html) throw new HttpError(404, 'mail not found');
    // Shown in a sandboxed iframe: no scripts, no external resources, links do not navigate the console.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(html);
  });

  return r;
}

/** Machine-to-machine endpoints (no user session). */
export function internalRouter(d: ExtensionDeps): Router {
  const r = Router();
  r.get('/gateway-config', (req, res) => {
    if (!safeEqual(bearer(req), d.config.GATEWAY_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
    res.json(d.gateway.build());
  });
  /** Guard policy for the evaluation agent of one agent container (fetched and cached by the agent). */
  r.get('/agents/:agentId/guard-config', (req, res) => {
    const entry = d.registry.get(req.params.agentId);
    if (!entry || !safeEqual(bearer(req), entry.secrets.internalToken)) return res.status(401).json({ error: 'unauthorized' });
    res.json(d.guard.getConfig());
  });
  /** An agent's guard blocked a tool call: record the alert and stop the agent. Idempotent on the alert id. */
  r.post('/agents/:agentId/security-alerts', express.json({ limit: '32kb' }), async (req, res) => {
    const entry = d.registry.get(req.params.agentId);
    if (!entry || !safeEqual(bearer(req), entry.secrets.internalToken)) return res.status(401).json({ error: 'unauthorized' });
    const { alert, created } = await d.guard.raise(entry.spec.agentId, securityWarningBody.parse(req.body));
    res.status(created ? 202 : 200).json({ id: alert.id, status: alert.status });
  });
  r.get('/avatars/:agentId/:mood', async (req, res) => {
    const entry = d.registry.get(req.params.agentId);
    if (!entry || !safeEqual(bearer(req), entry.secrets.internalToken)) return res.status(401).json({ error: 'unauthorized' });
    if (!isMood(req.params.mood)) return res.status(404).end();
    const meta = await d.avatars.meta(req.params.agentId);
    await sendImage(res, d.avatars.imagePath(req.params.agentId, req.params.mood), meta?.moods[req.params.mood]?.generatedAt);
  });
  /** Spend of the agent's virtual key over the last 30 days and whether a real AI model is usable (ADR-0029). */
  r.get('/agents/:agentId/spend', async (req, res) => {
    const entry = d.registry.get(req.params.agentId);
    if (!entry || !safeEqual(bearer(req), entry.secrets.internalToken)) return res.status(401).json({ error: 'unauthorized' });
    res.json(await d.ai.agentSpend(entry.spec, entry.secrets.aiKey, d.spendLimit(entry.spec)));
  });
  /** Human in the loop: the agent asks everybody with access to it for a decision (by e-mail). */
  r.post('/agents/:agentId/notify', express.json({ limit: '32kb' }), async (req, res) => {
    const entry = d.registry.get(req.params.agentId);
    if (!entry || !safeEqual(bearer(req), entry.secrets.internalToken)) return res.status(401).json({ error: 'unauthorized' });
    const body = notifyMailBody.parse(req.body);
    const agentId = entry.spec.agentId;
    // Users with a role for this agent (directly or for all agents); platform admins only by explicit role.
    const to = (await d.oauth.users())
      .filter((u) => !u.disabled && ((u.agentRoles[agentId]?.length ?? 0) > 0 || (u.agentRoles['*']?.length ?? 0) > 0))
      .map((u) => u.email)
      .sort();
    const { subject, html } = approvalMailHtml(entry.spec.displayName, body);
    const rec = await d.mail.send({ agentId, agentName: entry.spec.displayName, taskId: body.taskId, kind: body.kind, to, subject, html });
    await d.audit.write({ by: `agent:${agentId}`, action: 'mail.approval', target: agentId, details: { taskId: body.taskId, recipients: to.length, status: rec.status } });
    res.json({ id: rec.id, recipients: to.length, status: rec.status });
  });
  return r;
}
