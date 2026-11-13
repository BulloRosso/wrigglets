import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { SIGNALS_LIMITS, type ObservationInput, type SignalsConnectorStatus, type SignalsImapAccount } from '@cw/shared';
import type { Emit } from './mqtt.js';

/*
 * IMAP connector: polls one mailbox (and reacts to new-mail notifications while the connection idles), turns every
 * unseen message into an observation and then marks it as seen or moves it. The Message-ID is the reference for
 * de-duplication (outbox and agent). Attachments are not forwarded; their names are listed in the text.
 */

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

/** Parsed mail → observation (exported for tests). */
export function mailToObservation(mail: ParsedMail, accountId: string): ObservationInput {
  const from = mail.from?.text?.slice(0, 300);
  let body = (mail.text?.trim() || (typeof mail.html === 'string' ? htmlToText(mail.html) : '') || '(empty message)').slice(0, SIGNALS_LIMITS.maxBody - 500);
  const files = (mail.attachments ?? []).map((a) => `${a.filename ?? 'unnamed'} (${a.contentType}, ${a.size} bytes)`);
  if (files.length) body += `\n\n[Attachments, not forwarded: ${files.join('; ')}]`;
  return {
    source: 'imap',
    ref: mail.messageId ?? undefined,
    subject: mail.subject?.slice(0, SIGNALS_LIMITS.maxSubject),
    from,
    body,
    receivedAt: (mail.date ?? new Date()).toISOString(),
    reportedBy: `imap:${accountId}`,
  };
}

export async function parseMail(source: Buffer, accountId: string): Promise<ObservationInput> {
  return mailToObservation(await simpleParser(source), accountId);
}

export class ImapConnector {
  private client?: ImapFlow;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;
  readonly status: SignalsConnectorStatus;

  constructor(
    private readonly account: SignalsImapAccount,
    private readonly emit: Emit,
    private readonly password: () => Promise<string>,
  ) {
    this.status = { id: account.id, kind: 'imap', state: account.enabled ? 'connecting' : 'disabled', observations: 0 };
  }

  async start() {
    if (!this.account.enabled) return;
    const tick = () => void this.poll();
    this.timer = setInterval(tick, this.account.pollSeconds * 1000);
    this.timer.unref();
    tick();
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    const client = new ImapFlow({
      host: this.account.host,
      port: this.account.port,
      secure: this.account.secure,
      auth: { user: this.account.user, pass: await this.password() },
      logger: false,
      emitLogs: false,
    });
    client.on('error', (err: Error) => {
      this.status.state = 'down';
      this.status.lastError = String(err).slice(0, 300);
    });
    // new mail while idling → poll right away
    client.on('exists', () => void this.poll());
    client.on('close', () => {
      if (!this.stopped) this.status.state = 'down';
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const client = await this.connect();
      const lock = await client.getMailboxLock(this.account.mailbox);
      try {
        const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
        for (const uid of uids.slice(0, 50)) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const o = await parseMail(msg.source, this.account.id);
          await this.emit(this.account.agentId, o, `imap:${this.account.id}`);
          this.status.observations += 1;
          this.status.lastObservationAt = new Date().toISOString();
          // only after the observation is in the outbox
          if (this.account.moveTo) await client.messageMove(String(uid), this.account.moveTo, { uid: true });
          else await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
      this.status.state = 'up';
      this.status.lastError = undefined;
    } catch (err) {
      this.status.state = 'down';
      this.status.lastError = String(err instanceof Error ? err.message : err).slice(0, 300);
      await this.client?.logout().catch(() => undefined);
      this.client = undefined;
    } finally {
      this.polling = false;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.client?.logout().catch(() => undefined);
  }
}
