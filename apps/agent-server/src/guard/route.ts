import { timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import { z } from 'zod';
import type { GuardService } from './service.js';

const body = z.object({
  sessionID: z.string().min(1).max(200),
  callID: z.string().min(1).max(200),
  tool: z.string().min(1).max(200),
  args: z.unknown().optional(),
});

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `POST /internal/guard/evaluate` — only for the harness plugin: loopback and the per-boot token. */
export function mountGuard(app: Express, guard: Pick<GuardService, 'evaluate' | 'token'> | undefined) {
  if (!guard) return;
  app.post('/internal/guard/evaluate', express.json({ limit: '1mb' }), async (req, res) => {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '') || !safeEqual(token, guard.token)) return void res.status(401).json({ error: 'unauthorized' });
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid request' });
    res.json(await guard.evaluate({ ...parsed.data, args: parsed.data.args }));
  });
}
