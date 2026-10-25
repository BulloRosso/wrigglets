import { mkdtemp, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MailService, approvalMailHtml } from './mail.js';

const body = {
  kind: 'approval_requested' as const,
  taskId: 'task-1',
  title: 'Compare <offers> & prices',
  text: 'A plan is waiting for your approval.',
  link: 'http://localhost:8101/tasks/task-1',
  requestedBy: { upn: 'anna@example.com', name: 'Anna Becker' },
  awaiting: 'plan' as const,
};

describe('approval mail', () => {
  it('escapes user content and links every button into the decision dialog', () => {
    const { subject, html } = approvalMailHtml('Max', body);
    expect(subject).toBe('Max needs your approval — Compare <offers> & prices');
    expect(html).toContain('Compare &lt;offers&gt; &amp; prices');
    expect(html).not.toContain('<offers>');
    for (const d of ['approve', 'revise', 'reject', 'review']) expect(html).toContain(`http://localhost:8101/tasks/task-1?decide=${d}`);
  });

  it('writes the outbox only when no mail API is configured', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mail-'));
    const svc = new MailService(dir);
    const rec = await svc.send({ agentId: 'max', agentName: 'Max', kind: 'approval_requested', to: ['anna@example.com'], subject: 's', html: '<p>x</p>' });
    expect(rec).toMatchObject({ delivery: 'file', status: 'written' });
    expect((await readdir(path.join(dir, 'mail_out'))).sort()).toEqual([`${rec.id}.html`, `${rec.id}.json`]);
    expect(await svc.html(rec.id)).toBe('<p>x</p>');
    expect(await svc.html('../../etc/passwd')).toBeUndefined();
    expect((await svc.list()).map((m) => m.id)).toEqual([rec.id]);
  });

  it('posts { to, subject, body } to the mail API and records the outcome', async () => {
    let received: unknown;
    let auth: string | undefined;
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received = JSON.parse(data);
        auth = req.headers.authorization;
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/send`;
    try {
      const svc = new MailService(await mkdtemp(path.join(os.tmpdir(), 'mail-')), url, 'secret');
      const rec = await svc.send({ agentId: 'max', agentName: 'Max', kind: 'approval_requested', to: ['a@x.com', 'b@x.com'], subject: 'Hi', html: '<p>x</p>' });
      expect(rec).toMatchObject({ delivery: 'api', status: 'sent' });
      expect(received).toEqual({ to: ['a@x.com', 'b@x.com'], subject: 'Hi', body: '<p>x</p>' });
      expect(auth).toBe('Bearer secret');
    } finally {
      server.close();
    }
  });
});
