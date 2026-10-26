import { timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import { z } from 'zod';
import type { OboService } from './oboService.js';

const body = z.object({
  mode: z.enum(['obo', 'agent-only']),
  scope: z.string().min(1).max(300),
  /** Object id of the signed-in user behind the task (required for `obo`). */
  oid: z.string().min(1).max(100).optional(),
});

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const STATUS = { no_user_assertion: 401, interaction_required: 401, agent_only_not_allowed: 403, exchange_failed: 502 } as const;

/**
 * `POST /internal/obo-token` — only the MCP gateway (bearer A2A_GATEWAY_TOKEN) may ask for a token for one
 * tool call. Without the capability the route answers 404, so a disabled agent exposes nothing.
 */
export function mountObo(app: Express, obo: OboService | undefined, gatewayToken: string | undefined) {
  app.post('/internal/obo-token', express.json({ limit: '4kb' }), async (req, res) => {
    const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!gatewayToken || !equal(bearer, gatewayToken)) return void res.status(401).json({ code: 'unauthorized', message: 'Only the MCP gateway may request tokens.' });
    res.setHeader('Cache-Control', 'no-store');
    if (!obo) return void res.status(404).json({ code: 'obo_disabled', message: 'Entra OBO is not enabled for this agent.' });
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: 'bad_request', message: 'mode and scope are required' });
    const r = await obo.token(parsed.data);
    if (r.ok) return void res.json({ accessToken: r.accessToken, expiresAt: r.expiresAt, mode: r.mode });
    res.status(STATUS[r.code]).json({ code: r.code, message: r.message });
  });
}
