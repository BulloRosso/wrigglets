import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSpec } from '@cw/shared';
import { LiteLLMService } from './litellm.js';

const KEY = 'sk-agent-max';
const HASH = createHash('sha256').update(KEY).digest('hex');
const spec = { agentId: 'max', displayName: 'Max', model: 'gpt-5.4-mini' } as AgentSpec;

let server: Server;
let url = '';
let lastSpendQuery = '';

beforeAll(async () => {
  // Minimal fake of the LiteLLM endpoints the control plane uses
  server = createServer((req, res) => {
    const json = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.url === '/health/liveliness') return json('I am alive!');
    if (req.headers.authorization !== 'Bearer sk-master') return res.writeHead(401).end('{}');
    if (req.url === '/model/info')
      return json({ data: [{ model_name: 'gpt-5.4-mini', model_info: { input_cost_per_token: 7.5e-7, output_cost_per_token: 4.5e-6, cache_read_input_token_cost: 7.5e-8, max_input_tokens: 272000 } }] });
    if (req.url?.startsWith('/spend/logs')) {
      lastSpendQuery = req.url;
      return json([
        { [HASH]: 1.25, startTime: '2026-10-01', spend: 1.25 },
        { startTime: '2026-10-02', spend: 0 },
        { [HASH]: 0.5, otherKeyHash: 9, startTime: '2026-10-20', spend: 9.5 },
      ]);
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

describe('LiteLLM service', () => {
  it('reports models with prices per 1M tokens when OPENAI_API_KEY is present', async () => {
    const s = await new LiteLLMService({ url, masterKey: 'sk-master', openaiKeyPresent: true, defaultModel: 'gpt-5.4-mini' }).status(true);
    expect(s).toMatchObject({ configured: true, reachable: true });
    expect(s.models[0]).toEqual({ name: 'gpt-5.4-mini', inputUsdPer1M: 0.75, outputUsdPer1M: 4.5, cachedInputUsdPer1M: 0.075, contextTokens: 272000 });
  });

  it('sums only this key over a 30-day window and flags the limit', async () => {
    const svc = new LiteLLMService({ url, masterKey: 'sk-master', openaiKeyPresent: true, defaultModel: 'gpt-5.4-mini' });
    const sp = await svc.agentSpend(spec, KEY, 1.5);
    expect(sp).toMatchObject({ spentUsd: 1.75, limitUsd: 1.5, remainingUsd: 0, exceeded: true, windowDays: 30, ai: { configured: true } });
    const q = new URL(lastSpendQuery, url).searchParams;
    const days = (Date.parse(q.get('end_date')!) - Date.parse(q.get('start_date')!)) / 86_400_000;
    expect(days).toBe(30); // 29 days back + today, end date exclusive
  });

  it('explains what to configure when OPENAI_API_KEY is missing or LiteLLM is down', async () => {
    const noKey = await new LiteLLMService({ url, masterKey: 'sk-master', openaiKeyPresent: false, defaultModel: 'gpt-5.4-mini' }).status(true);
    expect(noKey).toMatchObject({ configured: false, reachable: true });
    expect(noKey.howToFix).toMatch(/OPENAI_API_KEY/);
    const down = await new LiteLLMService({ url: 'http://127.0.0.1:9', masterKey: 'sk-master', openaiKeyPresent: true, defaultModel: 'gpt-5.4-mini' }).status(true);
    expect(down).toMatchObject({ configured: false, reachable: false });
    expect(down.problem).toMatch(/not reachable/);
  });

  it('flags an unknown default model', async () => {
    const s = await new LiteLLMService({ url, masterKey: 'sk-master', openaiKeyPresent: true, defaultModel: 'gpt-9' }).status(true);
    expect(s.configured).toBe(false);
    expect(s.problem).toMatch(/gpt-9/);
  });
});
