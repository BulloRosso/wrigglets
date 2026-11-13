import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KillLevel } from '@cw/shared';
import { SignalsControlService, SignalsError } from './signals.js';
import { signalsAvailable } from './signalsApi.js';

let dir: string;
let level: KillLevel;
let fetchMock: ReturnType<typeof vi.fn>;
let audit: Array<{ action: string; target: string }>;
let svc: SignalsControlService;

const registry = {
  get: (id: string) => (id === 'lara' || id === 'max' ? { spec: { agentId: id }, secrets: { internalToken: `tok-${id}` } } : undefined),
  list: () => [{ agentId: 'lara' }, { agentId: 'max' }],
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'signals-cp-'));
  level = 'normal';
  audit = [];
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ observationId: 'sig-obs-lara-x', duplicate: false }), { status: 202 }));
  svc = new SignalsControlService(
    dir,
    registry as never,
    { internalUrl: (id: string) => `http://cw-agent-${id}:8080` },
    { effective: () => ({ level }) } as never,
    { write: async (e: { action: string; target: string }) => void audit.push(e) } as never,
    fetchMock as unknown as typeof fetch,
  );
  await svc.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SignalsControlService', () => {
  it('is available only with hub URL and token', () => {
    expect(signalsAvailable({ SIGNALS_HUB_URL: '', SIGNALS_HUB_TOKEN: 'x' })).toBe(false);
    expect(signalsAvailable({ SIGNALS_HUB_URL: 'http://signals-hub:7800', SIGNALS_HUB_TOKEN: undefined })).toBe(false);
    expect(signalsAvailable({ SIGNALS_HUB_URL: 'http://signals-hub:7800', SIGNALS_HUB_TOKEN: 'x' })).toBe(true);
  });

  it('keeps per-agent settings (off by default), persists them and lists enabled agents for the hub', async () => {
    expect(svc.agentConfig('lara').enabled).toBe(false);
    const v1 = svc.hubConfig().version;
    await svc.setAgentConfig('lara', { enabled: true, defaultAction: 'notify', owner: { upn: 'anna@example.com', name: 'Anna' } }, 'admin');
    expect(svc.hubConfig().agents).toEqual(['lara']);
    expect(svc.hubConfig().version).not.toBe(v1);
    const again = new SignalsControlService(dir, registry as never, { internalUrl: () => '' }, { effective: () => ({ level }) } as never, { write: async () => undefined } as never);
    await again.load();
    expect(again.agentConfig('lara')).toMatchObject({ enabled: true, defaultAction: 'notify', owner: { upn: 'anna@example.com' } });
    expect(audit.map((a) => a.action)).toContain('signals.agent');
    await expect(svc.setAgentConfig('nobody', { enabled: true }, 'admin')).rejects.toBeInstanceOf(SignalsError);
  });

  it('creates HTTP sources with a one-time token and stores only its hash', async () => {
    const { token } = await svc.createHttpSource('erp-events', 'lara', 'admin');
    const stored = svc.connectors().http[0]!;
    expect(stored.tokenSha256).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(svc.hubConfig())).not.toContain(token);
    await expect(svc.createHttpSource('erp-events', 'lara', 'admin')).rejects.toThrow(/exists/);
    await svc.deleteHttpSource('erp-events', 'admin');
    expect(svc.connectors().http).toHaveLength(0);
  });

  it('replaces IMAP and MQTT connectors but keeps HTTP sources and refuses duplicate ids', async () => {
    await svc.createHttpSource('erp-events', 'lara', 'admin');
    await svc.setConnectors(
      {
        imap: [{ id: 'office-mail', agentId: 'lara', host: 'greenmail', port: 3143, secure: false, user: 'office@sofaworks.test', passwordRef: 'signals-imap-office' }],
        mqtt: [{ id: 'plant', url: 'mqtt://mosquitto:1883', subscriptions: [{ topic: 'plant/+/alarm', agentId: 'max' }] }],
      },
      'admin',
    );
    expect(svc.connectors().http.map((s) => s.id)).toEqual(['erp-events']);
    expect(svc.connectors().imap[0]).toMatchObject({ mailbox: 'INBOX', pollSeconds: 60 });
    expect(svc.connectors().mqtt[0]!.subscriptions[0]).toMatchObject({ debounceSeconds: 10, maxPerHour: 30 });
    await expect(svc.setConnectors({ imap: [{ id: 'erp-events', agentId: 'lara', host: 'h', user: 'u', passwordRef: 'p' }] }, 'admin')).rejects.toThrow(/used twice/);
    await expect(svc.setConnectors({ imap: [{ id: 'x1', agentId: 'lara', host: 'h', user: 'u', passwordRef: 'not a ref!' }] }, 'admin')).rejects.toThrow();
  });

  it('forwards observations to enabled agents with their token, and refuses while the agent is paused', async () => {
    const obs = { agentId: 'lara', by: 'imap:office-mail', source: 'imap', subject: 'Booking', body: 'Your stay is confirmed', ref: '<m1@hotel>' };
    await expect(svc.forwardObservation(obs)).rejects.toMatchObject({ status: 409 });
    await svc.setAgentConfig('lara', { enabled: true }, 'admin');
    const out = await svc.forwardObservation(obs);
    expect(out.status).toBe(202);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://cw-agent-lara:8080/internal/signals/observe');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok-lara' });
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ by: 'imap:office-mail', ref: '<m1@hotel>' });
    level = 'paused';
    await expect(svc.forwardObservation(obs)).rejects.toMatchObject({ status: 503 });
  });

  it('reports an unreachable agent as 503 (the hub retries)', async () => {
    await svc.setAgentConfig('lara', { enabled: true }, 'admin');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(svc.forwardObservation({ agentId: 'lara', by: 'x', body: 'hello' })).rejects.toMatchObject({ status: 503 });
  });
});
