// Shared helpers of the Signals demo (docs/signals.md). Environment and the OIDC session come from the sofa-company
// example (scripts/sofa-company/lib.mjs, no dependencies); here: the cast and tiny SMTP and MQTT clients, so the demo
// needs no npm install.
import net from 'node:net';
export { ADMIN, OAUTH, PASSWORD, Session, env, log, sleep, until } from '../sofa-company/lib.mjs';
import { env } from '../sofa-company/lib.mjs';

export const HOST = env.PUBLIC_HOST || 'localhost';
export const HUB = `http://${HOST}:7800`;
export const AGENT = { id: 'office-ada', name: 'Ada', description: 'Administration: travel, hotel bookings, invoices, suppliers and customer follow-ups.' };
export const PERSON = { email: 'anna.berg@sofaworks.example', name: 'Anna Berg', title: 'Office manager' };
export const MAILBOX = { user: 'office@sofaworks.test', password: 'office-signals', secret: 'signals-imap-office' };

/** Sends one plain-text mail to the local test mail server (GreenMail, SMTP 3025 on localhost). */
export function sendMail({ from, to, subject, body, messageId }, port = 3025) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, HOST);
    const lines = [`EHLO demo`, `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA'];
    const data = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      ...body.split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l)),
      '.',
    ].join('\r\n');
    let step = 0;
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (chunk) => {
      buf += chunk;
      if (!/\r?\n$/.test(buf) || /^\d{3}-/m.test(buf.split(/\r?\n/).filter(Boolean).pop() ?? '')) return;
      const code = Number(buf.slice(0, 3));
      buf = '';
      if (code >= 400) return reject(new Error(`SMTP error ${code}`)), s.end();
      if (step < lines.length) s.write(`${lines[step++]}\r\n`);
      else if (step === lines.length) (s.write(`${data}\r\n`), step++);
      else (s.write('QUIT\r\n'), s.end(), resolve());
    });
    s.on('error', reject);
  });
}

/** Publishes one MQTT 3.1.1 message with QoS 0 to the local broker (Mosquitto, 1883 on localhost). */
export function publishMqtt(topic, payload, port = 1883) {
  const str = (v) => {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
  };
  const len = (n) => {
    const out = [];
    do {
      let d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d |= 128;
      out.push(d);
    } while (n > 0);
    return Buffer.from(out);
  };
  const connectBody = Buffer.concat([str('MQTT'), Buffer.from([4, 2, 0, 30]), str(`signals-demo-${process.pid}`)]);
  const publishBody = Buffer.concat([str(topic), Buffer.from(payload, 'utf8')]);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, HOST, () => s.write(Buffer.concat([Buffer.from([0x10]), len(connectBody.length), connectBody])));
    s.once('data', (d) => {
      if (d[0] !== 0x20 || d[3] !== 0) return reject(new Error('MQTT connect refused')), s.end();
      s.write(Buffer.concat([Buffer.from([0x30]), len(publishBody.length), publishBody]));
      s.end(Buffer.from([0xe0, 0]), resolve);
    });
    s.on('error', reject);
  });
}
