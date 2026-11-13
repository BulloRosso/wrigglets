#!/usr/bin/env node
// Sets up the Signals demo (docs/signals.md) on a running stack with the Signals overlay. Idempotent.
//
//   node scripts/stack.mjs env
//   docker compose -f docker-compose.yml -f docker-compose.signals.yml up -d --build
//   node scripts/signals-demo/setup.mjs
//
// 1. creates the agent Ada (administration) and the person Anna Berg (user + approver of Ada)
// 2. stores the test mailbox password in Key Vault and connects the hub to the GreenMail mailbox (IMAP) and the
//    Mosquitto topic facility/+/alarm (MQTT); creates the HTTP source "demo-http" and writes its token to .http-token
// 3. switches Signals on for Ada, with Anna as the person follow-up tasks are requested for; allows the signals__* tools
import { existsSync, writeFileSync } from 'node:fs';
import { ADMIN, AGENT, HOST, MAILBOX, PASSWORD, PERSON, Session, env, log, until } from './lib.mjs';

const admin = new Session();
log('signing in to the admin console');
await admin.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
const { available } = await admin.json('GET', `${ADMIN}/api/signals`);
if (!available) throw new Error('Signals is not configured: start the stack with docker-compose.signals.yml (see the header of this script)');

// 1. agent and person
let agents = await admin.json('GET', `${ADMIN}/api/agents?health=false`);
if (!agents.some((a) => a.spec.agentId === AGENT.id)) {
  log(`creating agent ${AGENT.name} (${AGENT.id})`);
  await admin.json('POST', `${ADMIN}/api/agents`, { agentId: AGENT.id, displayName: AGENT.name, description: AGENT.description, start: true });
  agents = await admin.json('GET', `${ADMIN}/api/agents?health=false`);
}
const spec = agents.find((a) => a.spec.agentId === AGENT.id).spec;
const users = await admin.json('GET', `${ADMIN}/api/users`);
const agentRoles = { [AGENT.id]: ['Agent.User', 'Agent.Approver'] };
const existing = users.find((u) => u.email.toLowerCase() === PERSON.email);
if (existing) await admin.json('PATCH', `${ADMIN}/api/users/${existing.id}`, { name: PERSON.name, agentRoles: { ...existing.agentRoles, ...agentRoles } });
else await admin.json('POST', `${ADMIN}/api/users`, { email: PERSON.email, name: PERSON.name, password: PASSWORD, platformRoles: [], agentRoles });
const anna = (await admin.json('GET', `${ADMIN}/api/users`)).find((u) => u.email.toLowerCase() === PERSON.email);
log(`${PERSON.name} (${PERSON.title}): user and approver of ${AGENT.name}, password ${PASSWORD}`);
const tools = await admin.json('GET', `${ADMIN}/api/agents/${AGENT.id}/tools`);
await admin.json('PUT', `${ADMIN}/api/agents/${AGENT.id}/tools`, { allowedTools: [...new Set([...tools.allowedTools, 'signals__*'])] });

// 2. connectors
await admin.json('PUT', `${ADMIN}/api/secrets/${MAILBOX.secret}`, { value: MAILBOX.password });
await admin.json('PUT', `${ADMIN}/api/signals/connectors`, {
  imap: [{ id: 'office-mail', agentId: AGENT.id, host: 'greenmail', port: 3143, secure: false, user: MAILBOX.user, passwordRef: MAILBOX.secret, mailbox: 'INBOX', pollSeconds: 15 }],
  mqtt: [{ id: 'facility', url: 'mqtt://mosquitto:1883', subscriptions: [{ topic: 'facility/+/alarm', agentId: AGENT.id, debounceSeconds: 5, maxPerHour: 20, maxPayloadBytes: 2000 }] }],
});
log(`connectors: IMAP ${MAILBOX.user} (GreenMail) and MQTT facility/+/alarm (Mosquitto) → ${AGENT.name}`);
const tokenFile = new URL('./.http-token', import.meta.url);
const overview = await admin.json('GET', `${ADMIN}/api/signals/overview`);
if (!overview.connectors.http.some((s) => s.id === 'demo-http') || !existsSync(tokenFile)) {
  if (overview.connectors.http.some((s) => s.id === 'demo-http')) await admin.json('DELETE', `${ADMIN}/api/signals/http-sources/demo-http`);
  const { token } = await admin.json('POST', `${ADMIN}/api/signals/http-sources`, { id: 'demo-http', agentId: AGENT.id });
  writeFileSync(tokenFile, token);
  log('HTTP source demo-http created; token in scripts/signals-demo/.http-token');
}

// 3. Signals on for Ada
await admin.json('PUT', `${ADMIN}/api/agents/${AGENT.id}/signals`, {
  enabled: true,
  owner: { upn: PERSON.email, name: PERSON.name, oid: anna.id },
  defaultAction: 'propose_task',
  brief:
    'You help the administration of Sofaworks (a sofa maker): travel and hotel bookings, incoming invoices, suppliers and promised answers of customers. ' +
    'Recognise business events and the open loops they create: an invoice after a stay, a confirmation after an order, an answer that was promised by a date, a technician after an alarm. ' +
    'Ignore newsletters and advertising. You may not act outside the platform without a person’s approval.',
});
log(`Signals switched on for ${AGENT.name}`);

await until(`${AGENT.name} healthy`, async () => (await (await fetch(`http://${HOST}:${spec.hostPort}/health`)).json()).status !== 'down', 300_000, 3000);
await until('hub has the new configuration', async () => (await admin.json('GET', `${ADMIN}/api/signals/overview`)).status?.connectors?.some((c) => c.id === 'office-mail'), 60_000, 2000);
log(`done: ${AGENT.name} at http://${HOST}:${spec.hostPort} (sign in as ${PERSON.email}), now run node scripts/signals-demo/run.mjs`);
