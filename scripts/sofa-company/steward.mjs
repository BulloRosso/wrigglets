#!/usr/bin/env node
// The people's side of the company wiki (ADR-0035): lists what the agents proposed and, with --decide <file.json>,
// decides on it as the platform admin. The decisions are made by a person (or by whoever runs the example), never by
// the agents: this script only carries them out.
//
//   node scripts/sofa-company/steward.mjs                    list the open proposals with reason, evidence and diff size
//   node scripts/sofa-company/steward.mjs --decide d.json    d.json: [{ "id": "…", "decision": "approve"|"reject", "comment": "…", "content": "optional corrected page text" }]
import { readFileSync } from 'node:fs';
import { ADMIN, Session, env, log } from './lib.mjs';

const args = process.argv.slice(2);
const admin = new Session();
await admin.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);

const at = args.indexOf('--decide');
if (at >= 0) {
  const list = JSON.parse(readFileSync(args[at + 1], 'utf8'));
  for (const d of list) {
    const r = await admin.json('POST', `${ADMIN}/api/wiki/proposals/${d.id}/decide`, { decision: d.decision, comment: d.comment, content: d.content });
    log(`${d.decision} ${r.id} ${r.path} (${r.agent})${d.comment ? `: ${d.comment}` : ''}`);
  }
} else {
  const open = await admin.json('GET', `${ADMIN}/api/wiki/proposals?status=pending`);
  for (const p of open) {
    console.log(`\n=== ${p.id}  ${p.path}  by ${p.agent}  (${p.current === null ? 'new page' : 'change'})  task ${p.task ?? '-'}`);
    console.log(`why:      ${p.reason}`);
    console.log(`evidence: ${p.evidence || '(none)'}`);
    console.log(`--- proposed text ---\n${p.content}`);
  }
  log(`${open.length} proposal(s) waiting`);
}
