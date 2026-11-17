#!/usr/bin/env node
// Health of the Liquid control loop from the shell (ADR-0051): the same items as Liquid enterprise → Overview.
// Exit code 0 = ok, 1 = warnings, 2 = failures (for CI and scripts). --json prints the raw result.
//
//   node scripts/liquid/doctor.mjs
import { ADMIN, Session, env } from '../sofa-company/lib.mjs';

const s = new Session();
await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
const h = await s.json('GET', `${ADMIN}/api/liquid/health`);
if (process.argv.includes('--json')) console.log(JSON.stringify(h, null, 2));
else {
  const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };
  console.log(`Liquid control loop: ${h.status.toUpperCase()} (checked ${h.checkedAt})`);
  for (const i of h.items) {
    console.log(`${mark[i.status]} ${i.label}: ${i.detail}`);
    if (i.status !== 'ok' && i.hint) console.log(`     → ${i.hint}${i.link ? ` (${ADMIN}${i.link})` : ''}`);
  }
}
process.exit(h.status === 'ok' ? 0 : h.status === 'warn' ? 1 : 2);
