import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservationInput, SignalsHubConfig } from '@cw/shared';
import { Hub } from './hub.js';
import { parseMail } from './imap.js';
import { callTool } from './mcp.js';
import { MqttRouter, topicMatches } from './mqtt.js';
import { Outbox, type DeliveryResult } from './outbox.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'signals-hub-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const obs = (over: Partial<ObservationInput> = {}): ObservationInput => ({ source: 'imap', ref: '<m1@hotel>', subject: 'Booking', body: 'Your stay is confirmed', ...over });

describe('Outbox', () => {
  it('queues durably, de-duplicates by reference and survives a restart', async () => {
    const deliver = vi.fn(async (): Promise<DeliveryResult> => ({ outcome: 'retry', error: 'down' }));
    const box = new Outbox(dir, deliver);
    await box.load();
    expect((await box.add('lara', obs(), 'imap:office')).queued).toBe(true);
    expect((await box.add('lara', obs(), 'imap:office')).queued).toBe(false);
    expect((await box.add('max', obs(), 'imap:office')).queued).toBe(true);
    const again = new Outbox(dir, deliver);
    await again.load();
    expect(again.status().pending).toBe(2);
  });

  it('retries with exponential backoff, delivers, remembers delivered references and drops refused entries', async () => {
    let t = 1_000_000;
    const results: DeliveryResult['outcome'][] = ['retry', 'retry', 'delivered'];
    const deliver = vi.fn(async (): Promise<DeliveryResult> => ({ outcome: results.shift() ?? 'delivered' }));
    const box = new Outbox(dir, deliver, { baseDelayMs: 1000, now: () => t });
    await box.load();
    await box.add('lara', obs(), 'x');
    await box.flush(); // attempt 1 → retry in 1 s
    await box.flush(); // not due
    expect(deliver).toHaveBeenCalledTimes(1);
    t += 1000;
    await box.flush(); // attempt 2 → retry in 2 s
    t += 1500;
    await box.flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    t += 600;
    await box.flush(); // attempt 3 → delivered
    expect(box.status().pending).toBe(0);
    expect((await box.add('lara', obs(), 'x')).queued).toBe(false); // delivered ref remembered

    const refusing = new Outbox(path.join(dir, 'b'), async () => ({ outcome: 'drop', error: '404: unknown agent' }));
    await refusing.load();
    await refusing.add('ghost', obs({ ref: undefined }), 'x');
    await refusing.flush();
    expect(refusing.status()).toMatchObject({ pending: 0, failed: 1 });
    expect(refusing.failed()[0]!.lastError).toMatch(/unknown agent/);
  });

  it('gives up after the maximum age', async () => {
    let t = 0;
    const box = new Outbox(dir, async () => ({ outcome: 'retry', error: 'agent paused' }), { baseDelayMs: 10, maxAgeMs: 1000, now: () => t });
    await box.load();
    await box.add('lara', obs(), 'x');
    t = 2000;
    await box.flush();
    expect(box.status()).toMatchObject({ pending: 0, failed: 1 });
  });
});

describe('MQTT', () => {
  it('matches topic filters', () => {
    expect(topicMatches('plant/+/alarm', 'plant/press-2/alarm')).toBe(true);
    expect(topicMatches('plant/+/alarm', 'plant/press-2/alarm/x')).toBe(false);
    expect(topicMatches('plant/#', 'plant/press-2/alarm/x')).toBe(true);
    expect(topicMatches('plant/press-1/alarm', 'plant/press-2/alarm')).toBe(false);
  });

  it('debounces per topic (the last message wins), caps the payload and limits per hour', async () => {
    vi.useFakeTimers();
    const emitted: Array<{ agent: string; o: ObservationInput }> = [];
    const r = new MqttRouter('plant', [{ topic: 'plant/+/alarm', agentId: 'max', debounceSeconds: 5, maxPerHour: 2, maxPayloadBytes: 16 }], async (agent, o) => void emitted.push({ agent, o }));
    r.handle('plant/press-2/alarm', Buffer.from('{"temp":80}'));
    r.handle('plant/press-2/alarm', Buffer.from('{"temp":95,"state":"overheat"}'));
    r.handle('other/topic', Buffer.from('ignored'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.agent).toBe('max');
    expect(emitted[0]!.o.body.startsWith('{"temp":95,"stat\n')).toBe(true);
    expect(emitted[0]!.o.body).toMatch(/payload cut at 16 bytes/);
    expect(emitted[0]!.o).toMatchObject({ source: 'mqtt', subject: 'MQTT plant/press-2/alarm' });
    r.handle('plant/press-1/alarm', Buffer.from('a'));
    await vi.advanceTimersByTimeAsync(5000);
    r.handle('plant/press-3/alarm', Buffer.from('b'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(emitted).toHaveLength(2);
    expect(r.dropped).toBe(1);
  });
});

describe('IMAP mail parsing', () => {
  it('turns a mail into an observation with Message-ID, subject, sender and text; attachments are only named', async () => {
    const eml = [
      'From: Hotel Nordlicht <reservations@hotel-nordlicht.example>',
      'To: office@sofaworks.test',
      'Subject: Your booking confirmation',
      'Message-ID: <booking-4711@hotel-nordlicht.example>',
      'Date: Thu, 12 Nov 2026 09:15:00 +0100',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Thank you for booking with <b>Hotel Nordlicht</b>.</p><p>Your stay from 18 to 20 November is confirmed.</p>',
      '--b1',
      'Content-Type: application/pdf; name="booking.pdf"',
      'Content-Disposition: attachment; filename="booking.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--b1--',
      '',
    ].join('\r\n');
    const o = await parseMail(Buffer.from(eml), 'office');
    expect(o).toMatchObject({ source: 'imap', ref: '<booking-4711@hotel-nordlicht.example>', subject: 'Your booking confirmation', receivedAt: '2026-11-12T08:15:00.000Z', reportedBy: 'imap:office' });
    expect(o.from).toContain('reservations@hotel-nordlicht.example');
    expect(o.body).toContain('Your stay from 18 to 20 November is confirmed.');
    expect(o.body).toContain('[Attachments, not forwarded: booking.pdf (application/pdf');
    expect(o.body).not.toContain('<p>');
  });
});

describe('Hub', () => {
  const token = 'sig_secret-token';
  const config: SignalsHubConfig = {
    version: 'v1',
    agents: ['lara'],
    connectors: { http: [{ id: 'erp-events', agentId: 'lara', tokenSha256: createHash('sha256').update(token).digest('hex'), enabled: true }], imap: [], mqtt: [] },
  };

  function makeHub(responses: Array<[number, unknown]>) {
    const fetchMock = vi.fn(async () => {
      const [status, body] = responses.shift() ?? [200, {}];
      return new Response(JSON.stringify(body), { status });
    });
    const box = new Outbox(dir, async () => ({ outcome: 'retry' }));
    const hub = new Hub({ controlPlaneUrl: 'http://cp', token: 'hub-token', secret: async () => 'pw', outbox: box, fetch: fetchMock as unknown as typeof fetch });
    return { hub, box, fetchMock };
  }

  it('loads its configuration and authenticates HTTP sources by token hash', async () => {
    const { hub } = makeHub([[200, config]]);
    expect(await hub.syncOnce()).toBe(true);
    expect(hub.httpSource(token)?.agentId).toBe('lara');
    expect(hub.httpSource('wrong')).toBeUndefined();
    expect(hub.httpSource('')).toBeUndefined();
  });

  it('refuses observations for agents without Signals', async () => {
    const { hub, box } = makeHub([[200, config]]);
    await box.load();
    await hub.syncOnce();
    await expect(hub.emit('max', obs(), 'x')).rejects.toMatchObject({ status: 409 });
    expect((await hub.emit('lara', obs(), 'x')) as { queued: boolean }).toMatchObject({ queued: true });
  });

  it('maps control-plane answers to outbox outcomes', async () => {
    const { hub } = makeHub([
      [202, {}],
      [200, { duplicate: true }],
      [503, { error: 'agent lara is paused' }],
      [409, { error: 'switched off' }],
      [404, { error: 'unknown agent' }],
    ]);
    const e = { id: '1', agentId: 'lara', by: 'x', observation: obs(), createdAt: '', attempts: 0, nextAt: 0 };
    expect((await hub.deliver(e)).outcome).toBe('delivered');
    expect((await hub.deliver(e)).outcome).toBe('delivered');
    expect(await hub.deliver(e)).toMatchObject({ outcome: 'retry', error: '503: agent lara is paused' });
    expect((await hub.deliver(e)).outcome).toBe('retry');
    expect((await hub.deliver(e)).outcome).toBe('drop');
  });
});

describe('MCP tools', () => {
  it('require the gateway-injected agent, and only resolve the caller\'s own expectations', async () => {
    const calls: string[] = [];
    const hub = {
      emit: vi.fn(async () => ({ queued: true })),
      controlPlane: vi.fn(async (method: string, route: string) => {
        calls.push(`${method} ${route}`);
        return method === 'GET' ? [{ id: 'sig-exp-lara-abc123-1' }] : { id: 'sig-exp-lara-abc123-1', state: 'fulfilled' };
      }),
    } as unknown as Hub;
    expect((await callTool(hub, 'observe', { body: 'x' })).isError).toBe(true);
    const ok = await callTool(hub, 'observe', { body: 'Customer promised an answer by Friday', _agent: 'lara', _task: 'task-1' });
    expect(ok.isError).toBeUndefined();
    expect(hub.emit).toHaveBeenCalledWith('lara', expect.objectContaining({ source: 'agent', reportedBy: 'agent:lara/task-1' }), 'agent:lara/task-1');
    const foreign = await callTool(hub, 'resolve_expectation', { id: 'sig-exp-max-zzz999-1', reason: 'r', _agent: 'lara' });
    expect(foreign.isError).toBe(true);
    const own = await callTool(hub, 'resolve_expectation', { id: 'sig-exp-lara-abc123-1', reason: 'Invoice found', _agent: 'lara' });
    expect(own.isError).toBeUndefined();
    expect(calls).toContain('POST /agents/lara/expectations/sig-exp-lara-abc123-1/fulfill');
  });
});
