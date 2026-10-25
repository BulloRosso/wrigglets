import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { logger } from './logger.js';

/*
 * Outgoing e-mail of agents (human in the loop, ADR-0026).
 *
 * Every mail is written to the outbox directory (`<DATA_DIR>/mail_out`: <id>.html + <id>.json) so that the admin
 * console can show exactly what was sent. When MAIL_API_URL is configured the mail is also delivered through that
 * endpoint: POST { to: string[], subject: string, body: string (HTML) }, optional bearer MAIL_API_KEY.
 */

export const notifyMailBody = z.object({
  kind: z.enum(['approval_requested', 'approval_reminder']),
  taskId: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  text: z.string().max(2000).optional(),
  link: z.string().url(),
  requestedBy: z.object({ upn: z.string(), name: z.string() }).optional(),
  awaiting: z.enum(['plan', 'deviation']).optional(),
});
export type NotifyMailBody = z.infer<typeof notifyMailBody>;

export interface MailRecord {
  id: string;
  at: string;
  agentId: string;
  agentName: string;
  taskId?: string;
  kind: string;
  to: string[];
  subject: string;
  delivery: 'api' | 'file';
  status: 'sent' | 'failed' | 'written';
  error?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const withParam = (link: string, value: string) => {
  const u = new URL(link);
  u.searchParams.set('decide', value);
  return u.toString();
};

/** HTML of an approval request; inline styles only (mail clients), links into the agent UI's decision dialog. */
export function approvalMailHtml(agentName: string, b: NotifyMailBody): { subject: string; html: string } {
  const reminder = b.kind === 'approval_reminder';
  const what = b.awaiting === 'deviation' ? 'a result with deviations' : 'a plan';
  const subject = `${reminder ? 'Reminder: ' : ''}${agentName} needs your approval — ${b.title}`;
  const button = (href: string, label: string, bg: string, fg = '#ffffff', border = bg) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:8px;background:${bg};color:${fg};border:1px solid ${border};font-weight:600;text-decoration:none">${esc(label)}</a>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f4f6fa;font-family:Roboto,'Segoe UI',Arial,sans-serif;color:#1d2733">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #dfe3ea">
    <tr><td style="padding:20px 24px;background:#1f5fad;border-radius:12px 12px 0 0;color:#ffffff">
      <div style="font-size:13px;opacity:.85">AI colleague</div>
      <div style="font-size:22px;font-weight:600">${esc(agentName)}</div>
    </td></tr>
    <tr><td style="padding:24px">
      <p style="margin:0 0 12px;font-size:16px">${reminder ? 'Reminder: ' : ''}<b>${esc(agentName)}</b> is waiting for a decision on ${what}:</p>
      <p style="margin:0 0 16px;font-size:18px;font-weight:600">${esc(b.title)}</p>
      ${b.requestedBy ? `<p style="margin:0 0 8px;color:#5b6777;font-size:14px">Requested by ${esc(b.requestedBy.name || b.requestedBy.upn)}</p>` : ''}
      ${b.text ? `<p style="margin:0 0 20px;color:#37414f;font-size:14px">${esc(b.text)}</p>` : ''}
      <div style="margin:8px 0 16px">
        ${button(withParam(b.link, 'approve'), 'Approve', '#2e7d32')}
        ${button(withParam(b.link, 'revise'), 'Request changes', '#ffffff', '#1f5fad', '#1f5fad')}
        ${button(withParam(b.link, 'reject'), 'Reject', '#ffffff', '#c62828', '#c62828')}
      </div>
      <p style="margin:0 0 4px;font-size:14px"><a href="${esc(withParam(b.link, 'review'))}" style="color:#1f5fad">Review the ${b.awaiting === 'deviation' ? 'result' : 'plan'} first</a></p>
      <p style="margin:20px 0 0;color:#5b6777;font-size:12px">Each button opens the decision dialog in ${esc(agentName)}'s web UI after sign-in; nothing is decided by clicking the link alone.
      You receive this e-mail because you have access to ${esc(agentName)}. Only approvers or the requester can decide; the first decision counts.</p>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html };
}

export class MailService {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly apiUrl?: string,
    private readonly apiKey?: string,
  ) {
    this.dir = path.join(dataDir, 'mail_out');
  }

  get delivery(): 'api' | 'file' {
    return this.apiUrl ? 'api' : 'file';
  }

  async send(input: { agentId: string; agentName: string; taskId?: string; kind: string; to: string[]; subject: string; html: string }): Promise<MailRecord> {
    await mkdir(this.dir, { recursive: true });
    const at = new Date();
    const id = `${at.toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${randomBytes(4).toString('hex')}`;
    const rec: MailRecord = { id, at: at.toISOString(), agentId: input.agentId, agentName: input.agentName, taskId: input.taskId, kind: input.kind, to: input.to, subject: input.subject, delivery: this.delivery, status: 'written' };
    await writeFile(path.join(this.dir, `${id}.html`), input.html);
    if (this.apiUrl && input.to.length) {
      try {
        const res = await fetch(this.apiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify({ to: input.to, subject: input.subject, body: input.html }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`mail API returned ${res.status}`);
        rec.status = 'sent';
      } catch (err) {
        rec.status = 'failed';
        rec.error = String(err instanceof Error ? err.message : err).slice(0, 300);
        logger.warn({ id, err: rec.error }, 'mail delivery failed');
      }
    }
    await writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(rec, null, 2));
    logger.info({ id, agentId: rec.agentId, to: rec.to.length, status: rec.status }, 'mail recorded');
    return rec;
  }

  async list(limit = 200): Promise<MailRecord[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit);
    const out: MailRecord[] = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(path.join(this.dir, f), 'utf8')) as MailRecord);
      } catch {
        /* skip broken entries */
      }
    }
    return out;
  }

  async html(id: string): Promise<string | undefined> {
    if (!/^[0-9TZ]+-[0-9a-f]{8}$/.test(id)) return undefined;
    return readFile(path.join(this.dir, `${id}.html`), 'utf8').catch(() => undefined);
  }
}
