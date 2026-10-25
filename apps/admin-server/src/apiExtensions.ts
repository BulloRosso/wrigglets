import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SecretStore } from '@cw/secrets';
import {
  AVATAR_MOODS,
  safetyRules,
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
import type { AdminAudit, AgentRegistry } from './registry.js';
import type { SafetyRuleEngine } from './safety.js';

export interface ExtensionDeps {
  config: Config;
  registry: AgentRegistry;
  audit: AdminAudit;
  avatars: AvatarService;
  killSwitch: KillSwitchService;
  gateway: GatewayConfigService;
  safety: SafetyRuleEngine;
  secrets?: SecretStore;
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

  return r;
}

/** Machine-to-machine endpoints (no user session). */
export function internalRouter(d: ExtensionDeps): Router {
  const r = Router();
  r.get('/gateway-config', (req, res) => {
    if (!safeEqual(bearer(req), d.config.GATEWAY_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
    res.json(d.gateway.build());
  });
  r.get('/avatars/:agentId/:mood', async (req, res) => {
    const entry = d.registry.get(req.params.agentId);
    if (!entry || !safeEqual(bearer(req), entry.secrets.internalToken)) return res.status(401).json({ error: 'unauthorized' });
    if (!isMood(req.params.mood)) return res.status(404).end();
    const meta = await d.avatars.meta(req.params.agentId);
    await sendImage(res, d.avatars.imagePath(req.params.agentId, req.params.mood), meta?.moods[req.params.mood]?.generatedAt);
  });
  return r;
}
