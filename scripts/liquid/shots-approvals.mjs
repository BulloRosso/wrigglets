#!/usr/bin/env node
// Documentation screenshots for ADR-0049 on the running stack: the one approval inbox (a playbook's restore step and a
// config pull request), the event log page, and the pull request on the Git host. Leaves the stack at its baseline:
// the run is cancelled and undone by hand, the pull request is closed.
import path from 'node:path';
import { ADMIN, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';
import { Shots } from '../sofa-company/shots.mjs';
import { docker } from './lib.mjs';

const s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
const UP = 'erp';
const dir = path.join(root, 'docs', 'images', 'liquid');
const secrets = JSON.parse(docker('exec', 'cw-temporal', 'cat', '/data/admin/extensions-secrets.json').stdout || '{}').liquid ?? {};
const FORGE_WEB = 'http://localhost:3300';

await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;

const sent = await api('POST', '/liquid/playbooks/alerts', { source: 'vuln-feed', severity: 'critical', upstream: UP, summary: 'CVE-2026-4711 in the ERP connector (docs)' });
const runId = sent.runs[0].runId;
await until('restore waits', async () => ((await api('GET', '/liquid/playbooks/runs')).find((r) => r.runId === runId)?.state === 'awaiting_approval' ? true : undefined), 120_000, 2000);
const allow = await api('GET', '/liquid/config/file?path=gateway/allow-lists.yaml');
const prop = await api('POST', '/liquid/proposals', {
  title: 'sofa-max may call erp__file_incident_report',
  reason: 'Max files the incident reports for late deliveries himself (docs example).',
  changes: [{ path: 'gateway/allow-lists.yaml', content: allow.content.replace(/(sofa-max:\n(?:\s+- .*\n)*?)(\s+- )/, '$1$2erp__file_incident_report\n$2') }],
});
log(`proposal ${prop.id} → ${prop.pr?.url}`);

const shots = await new Shots(dir).open();
try {
  await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid/approvals`, 'liquid-approvals', { width: 1500, height: 900, wait: 3000, fullPage: true });
  await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid/events`, 'liquid-events', { width: 1500, height: 900, wait: 3000 });
  if (prop.pr) {
    // the account keeps the language of its first sign-in: English for the docs
    await fetch(`${FORGE_WEB}/api/v1/user/settings`, { method: 'PATCH', headers: { authorization: `Basic ${Buffer.from(`reviewer:${secrets.forgejo_reviewer_password}`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ language: 'en-US' }) });
    const ctx = await shots.browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'en-US' });
    const p = await ctx.newPage();
    await p.goto(`${FORGE_WEB}/user/login`);
    await p.locator('#user_name').fill('reviewer');
    await p.locator('#password').fill(secrets.forgejo_reviewer_password);
    await p.locator('form.ui.form button.primary').first().click();
    await p.waitForLoadState('load');
    await p.goto(`${FORGE_WEB}/liquid/config/pulls/${prop.pr.number}`);
    await sleep(2000);
    await p.screenshot({ path: path.join(dir, 'forgejo-pull-request.png'), fullPage: true });
    await p.goto(`${FORGE_WEB}/liquid/config/pulls/${prop.pr.number}/files`);
    await sleep(2000);
    await p.screenshot({ path: path.join(dir, 'forgejo-pull-request-files.png') });
    await ctx.close();
  }
  log('screenshots written to docs/images/liquid');
} finally {
  await shots.close();
  // back to baseline: close the pull request, cancel the run and undo by hand
  if (prop.pr) {
    await fetch(`${FORGE_WEB}/api/v1/repos/liquid/config/pulls/${prop.pr.number}`, { method: 'PATCH', headers: { authorization: `Basic ${Buffer.from(`reviewer:${secrets.forgejo_reviewer_password}`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'closed' }) });
  }
  await api('POST', `/liquid/playbooks/runs/${runId}/cancel`, { reason: 'docs screenshots' }).catch(() => undefined);
  await api('POST', '/liquid/processes/release', { ref: runId }).catch(() => undefined);
  for (const o of (await api('GET', '/liquid/policy')).overlays.filter((x) => x.source?.includes(runId))) await api('DELETE', `/liquid/policy/overlays/${o.id}`);
  const up = (await api('GET', '/gateway')).upstreams.find((u) => u.name === UP);
  if (up && !up.enabled) await api('PUT', `/gateway/upstreams/${UP}`, { ...up, enabled: true });
  log('baseline restored');
}
