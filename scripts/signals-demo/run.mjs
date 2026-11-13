#!/usr/bin/env node
// Runs the Signals demo (docs/signals.md) against the REAL agent (real model, Temporal, hub, mail server, broker).
// Prerequisite: scripts/signals-demo/setup.mjs.
//
//   node scripts/signals-demo/run.mjs [--approve]
//
// 1. A hotel booking confirmation arrives by mail (SMTP → GreenMail → IMAP connector → hub → control plane → agent).
//    Ada interprets it: event "booking confirmed", expectation "the invoice arrives after the stay".
// 2. Time is shortened: Anna moves the due date of that expectation to "in 30 seconds" (as the UI does).
// 3. The expectation becomes overdue: Signals proposes a follow-up task; its plan waits for Anna's approval
//    (--approve: the script approves as Anna, otherwise do it in Ada's UI).
// 4. The invoice arrives late by mail: the signalled expectation is fulfilled and the loop is closed.
// 5. A newsletter arrives: zero events. 6. An MQTT alarm and 7. an HTTP post (a customer promises an answer by Friday).
// Results: scripts/signals-demo/results/run-<id>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ADMIN, AGENT, HOST, HUB, MAILBOX, PASSWORD, PERSON, Session, env, log, publishMqtt, sendMail, until } from './lib.mjs';

const approve = process.argv.includes('--approve');
const admin = new Session();
await admin.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
const spec = (await admin.json('GET', `${ADMIN}/api/agents/${AGENT.id}`)).spec;
const BASE = `http://${HOST}:${spec.hostPort}`;
const anna = new Session();
await anna.signIn(BASE, PERSON.email, PASSWORD);
log(`signed in to ${AGENT.name} (${BASE}) as ${PERSON.name}`);

const run = Date.now().toString(36);
const out = { startedAt: new Date().toISOString(), agent: AGENT.id, steps: [] };
const record = (step, data) => (out.steps.push({ step, at: new Date().toISOString(), ...data }), data);
const observations = () => anna.json('GET', `${BASE}/api/signals/observations?limit=50`);
const waitObservation = (subject) => until(`observation "${subject}"`, async () => (await observations()).find((o) => o.subject === subject), 180_000, 3000);
const mail = (subject, body, from) => sendMail({ from, to: MAILBOX.user, subject, body, messageId: `<${run}-${subject.replace(/\W+/g, '-').toLowerCase()}@demo.example>` });
const show = (o) => {
  log(`  events: ${o.events.map((e) => `${e.type} (${e.summary})`).join('; ') || 'none'}${o.note ? ` (${o.note})` : ''}`);
  if (o.created.length) log(`  new expectations: ${o.created.join(', ')}`);
  if (o.fulfilled.length) log(`  fulfilled: ${o.fulfilled.map((f) => `${f.expectationId} (${f.reason})`).join(', ')}`);
  if (o.error) log(`  error: ${o.error}`);
};

// 1. the hotel booking confirmation
const hotelSubject = `Your booking confirmation ${run}`;
log('1. mail: hotel booking confirmation');
await mail(hotelSubject, 'Good day,\n\nthank you for booking with Hotel Nordlicht. Your stay from 18 to 20 November is confirmed. You will receive the invoice after your departure.\n\nKind regards\nYour hotel team', 'reservations@hotel-nordlicht.example');
const hotel = record('hotel-booking', await waitObservation(hotelSubject));
show(hotel);
if (!hotel.created.length) throw new Error('no expectation was derived from the booking confirmation; see the observation above');
const states = await Promise.all(hotel.created.map((id) => anna.json('GET', `${BASE}/api/signals/expectations/${id}`)));
const invoice = states.find((s) => /invoice/i.test(`${s.title} ${s.matchHint}`)) ?? states[0];
log(`  tracked: "${invoice.title}", due ${invoice.dueAt}, then: ${invoice.action}`);

// 2. shorten the time: due in 30 seconds, and make sure a follow-up task is proposed
log('2. Anna moves the due date to "in 30 seconds"');
await anna.json('POST', `${BASE}/api/signals/expectations/${invoice.id}/edit`, { dueAt: new Date(Date.now() + 30_000).toISOString(), action: 'propose_task' });

// 3. overdue → follow-up task with a plan to approve
log('3. waiting for the signal');
const signalled = await until(
  'signal',
  async () => {
    const s = await anna.json('GET', `${BASE}/api/signals/expectations/${invoice.id}`);
    return s.signal?.taskId || s.signal?.error ? s : undefined;
  },
  120_000,
  3000,
);
record('signal', { expectation: invoice.id, signal: signalled.signal });
if (signalled.signal.error) throw new Error(`signal failed: ${signalled.signal.error}`);
const taskId = signalled.signal.taskId;
log(`  follow-up task ${taskId} (${BASE}/tasks/${taskId})`);
const waiting = await until(
  'plan of the follow-up task',
  async () => {
    const t = await anna.json('GET', `${BASE}/api/tasks/${taskId}`);
    return t.state.status === 'awaiting_approval' || ['failed', 'cancelled'].includes(t.state.status) ? t : undefined;
  },
  900_000,
  5000,
);
record('follow-up-plan', { taskId, status: waiting.state.status, plan: waiting.state.plan?.summary });
log(`  plan: ${waiting.state.plan?.summary?.slice(0, 300) ?? waiting.state.status}`);
if (approve && waiting.state.status === 'awaiting_approval') {
  await anna.json('POST', `${BASE}/api/tasks/${taskId}/decision`, { decision: 'approve', comment: 'Fine: prepare the inquiry draft, I will send it.' });
  log('  approved by Anna (--approve)');
} else log("  waiting for Anna's decision in the UI (or run with --approve)");

// 4. the invoice arrives (late): the loop closes
const invoiceSubject = `Invoice 2026-1187 for your stay ${run}`;
log('4. mail: the invoice arrives');
await mail(invoiceSubject, 'Good day,\n\nplease find attached the invoice for your stay from 18 to 20 November at Hotel Nordlicht. Amount: EUR 412.00, payable within 14 days.\n\nKind regards\nHotel Nordlicht, accounting', 'billing@hotel-nordlicht.example');
show(record('invoice', await waitObservation(invoiceSubject)));
const closed = await anna.json('GET', `${BASE}/api/signals/expectations/${invoice.id}`);
log(`  expectation "${closed.title}" is now ${closed.state}`);

// 5. a newsletter: nothing follows
const newsSubject = `Ramen of the week ${run}`;
log('5. mail: newsletter');
await mail(newsSubject, 'This week at Noodle Bar Mitte: spicy miso ramen with roasted corn. 10 % off with the code MISO10 until Sunday. Unsubscribe here.', 'news@noodlebar.example');
show(record('newsletter', await waitObservation(newsSubject)));

// 6. a machine message over MQTT
log('6. MQTT: facility/hall-2/alarm');
await publishMqtt('facility/hall-2/alarm', JSON.stringify({ device: 'sprinkler-pump-2', state: 'fault', code: 'E42', message: 'Pressure low, service technician required', at: new Date().toISOString() }));
show(record('mqtt', await waitObservation('MQTT facility/hall-2/alarm')));

// 7. an HTTP post from another system (e.g. the CRM): a customer promises an answer
const httpSubject = `Re: Offer for 40 lounge sofas ${run}`;
log('7. HTTP: the CRM posts a customer mail');
const token = readFileSync(new URL('./.http-token', import.meta.url), 'utf8').trim();
const posted = await fetch(`${HUB}/observations`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ subject: httpSubject, from: 'purchasing@cafe-hafenblick.example', body: 'Hello, thank you for the offer. We will discuss it internally and get back to you by Friday. Best regards, Mara Lindqvist', ref: `crm-${run}` }),
});
if (!posted.ok) throw new Error(`hub refused the HTTP observation: ${posted.status} ${await posted.text()}`);
show(record('http', await waitObservation(httpSubject)));

out.open = await anna.json('GET', `${BASE}/api/signals/expectations?status=open`);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./results/run-${run}.json`, import.meta.url), JSON.stringify(out, null, 2));
log(`done: ${out.open.length} open expectations; results in scripts/signals-demo/results/run-${run}.json; UI: ${BASE}/signals`);
