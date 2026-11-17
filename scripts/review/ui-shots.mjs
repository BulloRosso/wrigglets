#!/usr/bin/env node
// Screenshots of every screen for the UI review (docs/review/user-interface.md), one file per screen ID.
//   node scripts/review/ui-shots.mjs before|after [ID ...]
// Needs the running stack with Liquid Enterprise installed and the sofa agents (scripts/sofa-company).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, HUMANS, Session, env, log, root } from '../sofa-company/lib.mjs';
import { Shots } from '../sofa-company/shots.mjs';

const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) {
  console.error('usage: ui-shots.mjs before|after [ID ...]');
  process.exit(2);
}
const only = new Set(process.argv.slice(3));
const HOST = env.PUBLIC_HOST || 'localhost';
const AGENT = `http://${HOST}:8105`; // sofa-max, Paula's agent
const APPS = `http://${HOST}:8090`;
const admin = env.BOOTSTRAP_ADMIN_EMAIL;
const paula = HUMANS.paula.email;
const stefan = HUMANS.stefan.email;

// ids of objects that detail screens need
const s = new Session();
await s.signIn(ADMIN, admin, env.BOOTSTRAP_ADMIN_PASSWORD);
const proposals = await s.json('GET', `${ADMIN}/api/liquid/proposals`).catch(() => []);
const proposal = (proposals.proposals ?? proposals).find((p) => p.irDiff) ?? (proposals.proposals ?? proposals)[0];
const a = new Session();
await a.signIn(AGENT, paula, env.DEMO_USER_PASSWORD || 'Welcome-2026!').catch(() => undefined);
const tasks = await a.json('GET', `${AGENT}/api/tasks`).catch(() => []);
const task = (tasks.items ?? tasks.tasks ?? (Array.isArray(tasks) ? tasks : []))[0];

/** The screen catalog: ID, title, who looks at it, URL. */
export const SCREENS = [
  ['ADM-01', 'Dashboard', admin, `${ADMIN}/dashboard`],
  ['ADM-02', 'Agents', admin, `${ADMIN}/agents`],
  ['ADM-03', 'Agent detail', admin, `${ADMIN}/agents/sofa-max`],
  ['ADM-04', 'Safety & tools', admin, `${ADMIN}/safety`],
  ['ADM-05', 'Company wiki', admin, `${ADMIN}/wiki`],
  ['ADM-06', 'Mail outbox', admin, `${ADMIN}/mail`],
  ['ADM-07', 'Users & access', admin, `${ADMIN}/users`],
  ['ADM-08', 'Audit log', admin, `${ADMIN}/audit`],
  ['ADM-09', 'Extensions', admin, `${ADMIN}/extensions`],
  ['ADM-10', 'Signals', admin, `${ADMIN}/signals`],
  ['LIQ-01', 'Liquid overview', admin, `${ADMIN}/liquid`],
  ['LIQ-02', 'Approvals', admin, `${ADMIN}/liquid/approvals`],
  ['LIQ-03', 'Ontology', admin, `${ADMIN}/liquid/ontology`],
  ['LIQ-04', 'Policies', admin, `${ADMIN}/liquid/policies`],
  ['LIQ-05', 'Business processes', admin, `${ADMIN}/liquid/processes`],
  ['LIQ-06', 'Proposals', admin, `${ADMIN}/liquid/proposals`],
  ['LIQ-07', 'Proposal detail', admin, proposal ? `${ADMIN}/liquid/proposals/${proposal.id}` : undefined],
  ['LIQ-08', 'Playbooks', admin, `${ADMIN}/liquid/playbooks`],
  ['LIQ-09', 'Event log', admin, `${ADMIN}/liquid/events`],
  ['LIQ-10', 'Apps', admin, `${ADMIN}/liquid/apps`],
  ['AGT-01', 'Agent chat', paula, `${AGENT}/`],
  ['AGT-02', 'Tasks', paula, `${AGENT}/tasks`],
  ['AGT-03', 'Task detail', paula, task ? `${AGENT}/tasks/${task.taskId ?? task.id}` : undefined],
  ['AGT-04', 'Timeline', paula, `${AGENT}/timeline`],
  ['AGT-05', 'Schedules', paula, `${AGENT}/schedules`],
  ['AGT-06', 'Signals (agent)', paula, `${AGENT}/signals`],
  ['AGT-07', 'Audit (agent)', paula, `${AGENT}/audit`],
  ['AGT-08', 'Workspace', paula, `${AGENT}/workspace/`],
  ['APP-01', 'App host', 'anonymous', `${APPS}/`],
  ['APP-02', 'Sample app', stefan, `${APPS}/apps/supplier-due-diligence/`],
];

/** Views that exist only after the review: role views and second-level tabs (taken in the "after" phase). */
export const VARIANTS = [
  ['ADM-01-IT', 'Dashboard, IT Engineer view', admin, `${ADMIN}/dashboard?role=it`],
  ['ADM-01-BE', 'Dashboard, Business Engineer view', admin, `${ADMIN}/dashboard?role=business`],
  ['ADM-02-BE', 'Agents, Business Engineer view', admin, `${ADMIN}/agents?role=business`],
  ['ADM-03-WORK', 'Agent detail, Work → Tasks', admin, `${ADMIN}/agents/sofa-max?tab=work&role=all`],
  ['ADM-03-BE', 'Agent detail, Business Engineer view', admin, `${ADMIN}/agents/sofa-max?tab=profile&role=business`],
  ['ADM-09-OPEN', 'Extensions, services and last operation unfolded', admin, `${ADMIN}/extensions?role=all`, 'unfold'],
  ['LIQ-01-IT', 'Liquid overview, IT Engineer view', admin, `${ADMIN}/liquid?role=it`],
  ['LIQ-01-BE', 'Liquid overview, Business Engineer view', admin, `${ADMIN}/liquid?role=business`],
  ['LIQ-05-RUN', 'Business processes, Running', admin, `${ADMIN}/liquid/processes?tab=running&role=all`],
  ['LIQ-07-ONTO', 'Proposal detail, Ontology changes', admin, proposal ? `${ADMIN}/liquid/proposals/${proposal.id}?view=ontology&role=all` : undefined],
  ['LIQ-10-REG', 'Apps, registration step 1', admin, `${ADMIN}/liquid/apps?role=all`, 'register'],
  ['AGT-03-ACT', 'Task detail, Activity', paula, task ? `${AGENT}/tasks/${task.taskId ?? task.id}` : undefined, 'activity'],
];

const dir = path.join(root, 'docs', 'review', 'img', phase);
mkdirSync(dir, { recursive: true });
process.env.ADMIN_EMAIL = admin;
process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
const shots = await new Shots(dir).open();
try {
  // the role view is remembered per browser: the default screens are taken in the "All" view
  const catalog = [...SCREENS.map(([id, t, who, url]) => [id, t, who, url && url.startsWith(ADMIN) ? `${url}${url.includes('?') ? '&' : '?'}role=all` : url]), ...(phase === 'after' ? VARIANTS : [])];
  for (const [id, title, who, url, action] of catalog) {
    if (only.size && !only.has(id)) continue;
    if (!url) {
      log(`${id} ${title}: skipped (no object to show)`);
      continue;
    }
    try {
      if (who === 'anonymous') {
        // a page without sign-in (the app host's index)
        const ctx = await shots.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const p = await ctx.newPage();
        await p.goto(url);
        await p.screenshot({ path: path.join(dir, `${id}.png`), fullPage: true });
        await ctx.close();
        log(`${id} ${title}`);
        continue;
      }
      // a screen reached by a click (a dialog, a tab without its own URL)
      const before = action ? async (page) => {
        if (action === 'register') await page.getByRole('button', { name: 'Register app' }).click();
        if (action === 'unfold') for (let i = 0, folded = page.locator('.MuiAccordionSummary-root[aria-expanded=false]'); i < 10 && (await folded.count()); i++) await folded.first().click();
        if (action === 'activity') await page.getByRole('tab', { name: /Activity/ }).click();
        await page.waitForTimeout(1500);
      } : undefined;
      await shots.snap(who, url, id, { width: 1440, height: 900, wait: 3500, fullPage: true, before });
      log(`${id} ${title}`);
    } catch (err) {
      log(`${id} ${title}: ${String(err).slice(0, 160)}`);
    }
  }
  // the sign-in page, as someone who is not signed in sees it
  if (!only.size || only.has('AUTH-01')) {
    const ctx = await shots.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${ADMIN}/auth/login`);
    await p.waitForLoadState('networkidle').catch(() => undefined);
    await p.screenshot({ path: path.join(dir, 'AUTH-01.png'), fullPage: true });
    await ctx.close();
    log('AUTH-01 Sign-in');
  }
} finally {
  await shots.close();
}
