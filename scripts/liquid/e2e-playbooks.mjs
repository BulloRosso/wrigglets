#!/usr/bin/env node
// M7 check on the running stack (exit criterion): a synthetic alert runs the example playbook end to end on the sofa
// company; every tightening step takes effect automatically (upstream disabled, overlay, held workflows); restore waits
// for a person; after approval everything is back to baseline (gateway config, OPA overlays, held workflows diffed
// before/after). Also: every step is an event, the reconciler keeps the tightening (it is in the config repository),
// cancel never loosens, the alert endpoint needs its token, an auto-loosening playbook cannot be proposed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';

const args = new Set(process.argv.slice(2));
const result = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const s = new Session();
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const UP = 'erp';
const ALERT = { source: 'vuln-feed', severity: 'critical', upstream: UP, summary: 'CVE-2026-4711 in the ERP connector (e2e)' };

function onto(method, p, body) {
  const script = `fetch('http://127.0.0.1:7710' + process.argv[1], { method: process.argv[2], headers: { authorization: 'Bearer ' + process.env.INTERNAL_TOKEN, 'content-type': 'application/json' }, body: process.argv[3] || undefined })
    .then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }))).catch((e) => { console.error(String(e)); process.exit(1); })`;
  const r = docker('exec', 'cw-ext-liquid-ontology-server', 'node', '-e', script, p, method, body ? JSON.stringify(body) : '');
  return JSON.parse(r.stdout);
}
const sql = (q) => docker('exec', 'cw-ext-liquid-ontology-db', 'psql', '-U', 'onto', '-d', 'onto', '-tAc', q).stdout.trim();
const snapshot = async () => {
  const gw = await api('GET', '/gateway');
  const pol = await api('GET', '/liquid/policy');
  const pr = await api('GET', '/liquid/processes');
  const cfg = await api('GET', '/liquid/config/file?path=gateway/upstreams.yaml');
  return {
    upstreams: JSON.stringify(gw.upstreams.map((u) => ({ name: u.name, enabled: u.enabled })).sort((a, b) => a.name.localeCompare(b.name))),
    overlays: JSON.stringify(pol.overlays.map((o) => o.id).sort()),
    held: pr.running.filter((r) => r.hold?.held).map((r) => r.workflowId).sort().join(','),
    repoUpstreams: cfg.content,
  };
};
const runOf = async (runId) => (await api('GET', '/liquid/playbooks/runs')).find((r) => r.runId === runId);

try {
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  // leftovers of an aborted earlier run: cancel open runs and undo by hand (the console path a person would take)
  for (const r of await api('GET', '/liquid/playbooks/runs')) {
    if (!['running', 'awaiting_approval'].includes(r.state)) continue;
    await api('POST', `/liquid/playbooks/runs/${r.runId}/cancel`, { reason: 'e2e pre-clean' }).catch(() => undefined);
    await api('POST', '/liquid/processes/release', { ref: r.runId }).catch(() => undefined);
  }
  for (const o of (await api('GET', '/liquid/policy')).overlays.filter((x) => x.source?.startsWith('playbook:'))) await api('DELETE', `/liquid/policy/overlays/${o.id}`);
  const up0 = (await api('GET', '/gateway')).upstreams.find((u) => u.name === UP);
  if (up0 && !up0.enabled) await api('PUT', `/gateway/upstreams/${UP}`, { ...up0, enabled: true });
  const pbs = await api('GET', '/liquid/playbooks');
  check('the example playbook is in the config repository and valid', pbs.playbooks.some((p) => p.id === 'third-party-upstream-vulnerability') && pbs.invalid.length === 0, Object.values(pbs.sources));

  // the alert endpoint needs its token
  const anon = await fetch(`${ADMIN}/internal/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ALERT) });
  check('POST /internal/alerts without the token is refused', anon.status === 401, anon.status);

  // a running business process in the blast radius
  await api('POST', '/liquid/sim/reset');
  const created = onto('POST', '/actions/create_purchase_order', { supplierId: 'S-BALTIC', sku: 'BEAM-PINE-80', quantity: 1500, _requestedBy: 'e2e-playbooks' });
  const poId = JSON.parse(created.body.result).id;
  await until('PurchaseOrderRelease running', async () => (await api('GET', '/liquid/processes')).running.find((r) => r.objects.includes(`PurchaseOrder:${poId}`)), 30_000, 1000);
  const base = await snapshot();
  check('baseline: erp enabled, no hold', base.upstreams.includes(`{"name":"${UP}","enabled":true}`) && base.held === '', { overlays: base.overlays });
  const seq0 = Number(sql('SELECT coalesce(max(seq),0) FROM events'));

  // 1. synthetic alert → run
  const sent = await api('POST', '/liquid/playbooks/alerts', ALERT);
  check('the alert starts the matching playbook', sent.runs.length === 1 && sent.runs[0].playbook === 'third-party-upstream-vulnerability', sent.runs);
  const runId = sent.runs[0].runId;
  const waiting = await until('run waits for the person', async () => {
    const r = await runOf(runId);
    return r?.state === 'awaiting_approval' ? r : undefined;
  }, 120_000, 2000);
  const st = Object.fromEntries(waiting.steps.map((x) => [x.id, x]));
  check('tightening steps ran automatically; propose-fix is a pending proposal; restore waits', ['disable-upstream', 'tighten-policy', 'hold-workflows', 'notify-owners', 'replay'].every((k) => st[k].state === 'done') && st['propose-fix'].state === 'proposed' && st.restore.state === 'awaiting_approval', waiting.steps.map((x) => `${x.id}=${x.state}`));
  check('blast radius: erp tools → write actions → classes → the running purchase order', waiting.blast.writeActions.includes('create_purchase_order') && waiting.blast.classes.includes('PurchaseOrder') && waiting.blast.objects.includes(`PurchaseOrder:${poId}`), { tools: waiting.blast.tools.length, writeActions: waiting.blast.writeActions.length, workflows: waiting.blast.workflows.length });
  const mid = await snapshot();
  check('effects: upstream disabled, overlay added, workflow held', mid.upstreams.includes(`{"name":"${UP}","enabled":false}`) && mid.overlays !== base.overlays && mid.held.length > 0, { overlays: mid.overlays, held: mid.held });
  check('shadow replay reported on the last 7 days', /replayed \d+ events/.test(st.replay.summary), st.replay.summary);
  const rec = await api('POST', '/liquid/config/reconcile');
  await sleep(1000);
  const afterRec = await snapshot();
  check('the reconciler keeps the tightening (it was committed to the config repository)', rec.ok && afterRec.upstreams === mid.upstreams && afterRec.overlays === mid.overlays && /enabled: false/.test(afterRec.repoUpstreams));
  const types = sql(`SELECT string_agg(type || ':' || n, ',') FROM (SELECT type, count(*) n FROM events WHERE seq > ${seq0} AND type IN ('AlertReceived','PlaybookRunStarted','PlaybookStepExecuted','PlaybookStepAwaitingApproval','AgentTaskRequested','BusinessNotification') GROUP BY type ORDER BY type) t`);
  check('alert, run start and every step are events in the event log', /AlertReceived:1/.test(types) && /PlaybookRunStarted:1/.test(types) && /PlaybookStepExecuted:6/.test(types) && /PlaybookStepAwaitingApproval:1/.test(types), types);
  if (!args.has('--no-shots')) await shot('/liquid/playbooks', 'liquid-playbooks', 1500);

  const inbox = await api('GET', '/liquid/inbox');
  check('restore is an approval in the one inbox (ApprovalWorkflow, kind playbook-step)', inbox.some((i) => i.kind === 'playbook-step' && i.detail?.effect?.runId === runId && i.detail?.effect?.stepId === 'restore'), inbox.filter((i) => i.kind === 'playbook-step').map((i) => i.subject));
  // 2. a person approves restore → baseline
  await api('POST', `/liquid/playbooks/runs/${runId}/steps/restore/decide`, { decision: 'approve', comment: 'connector patched (e2e)' });
  const done = await until('run completed', async () => {
    const r = await runOf(runId);
    return r?.state === 'completed' ? r : undefined;
  }, 60_000, 2000);
  const restoreStep = done.steps.find((x) => x.id === 'restore');
  await sleep(1500);
  const end = await snapshot();
  check('after approval everything is back to baseline (upstreams, overlays, held workflows, repository)', end.upstreams === base.upstreams && end.overlays === base.overlays && end.held === base.held && end.repoUpstreams === base.repoUpstreams, restoreStep.summary);
  check('restore was approved by the signed-in person', restoreStep.approvedBy === env.BOOTSTRAP_ADMIN_EMAIL);
  const fin = sql(`SELECT count(*) FROM events WHERE seq > ${seq0} AND type IN ('PlaybookRunFinished','IncidentRecorded','PlaybookStepDecided') AND object_id = '${runId}'`);
  check('decision, end of run and incident are events', Number(fin) === 3, fin);

  // 3. cancel never loosens
  const second = (await api('POST', '/liquid/playbooks/alerts', ALERT)).runs[0];
  await until('second run waits', async () => ((await runOf(second.runId))?.state === 'awaiting_approval' ? true : undefined), 120_000, 2000);
  await api('POST', `/liquid/playbooks/runs/${second.runId}/cancel`, { reason: 'handled by hand (e2e)' });
  const cancelled = await until('run cancelled', async () => {
    const r = await runOf(second.runId);
    return r?.state === 'cancelled' ? r : undefined;
  }, 60_000, 2000);
  const afterCancel = await snapshot();
  check('a cancelled run loosens nothing (erp stays disabled until a person enables it)', cancelled.steps.find((x) => x.id === 'restore').state === 'cancelled' && afterCancel.upstreams.includes(`{"name":"${UP}","enabled":false}`));
  // manual cleanup by a person (the console path)
  const up = (await api('GET', '/gateway')).upstreams.find((u) => u.name === UP);
  await api('PUT', `/gateway/upstreams/${UP}`, { ...up, enabled: true });
  for (const o of (await api('GET', '/liquid/policy')).overlays.filter((x) => x.source?.includes(second.runId))) await api('DELETE', `/liquid/policy/overlays/${o.id}`);
  await api('POST', '/liquid/processes/release', { ref: second.runId });
  await sleep(1500);
  const clean = await snapshot();
  check('manual cleanup by a person restores the baseline', clean.upstreams === base.upstreams && clean.overlays === base.overlays && clean.held === base.held);

  // 4. an auto-loosening playbook cannot reach main
  const bad = await api('POST', '/liquid/proposals', {
    title: 'Auto-restore after alerts (e2e)',
    reason: 'faster recovery',
    changes: [{ path: 'playbooks/auto-restore.yaml', content: 'id: auto-restore\nversion: 1\ntrigger: { kind: alert, match: { source: vuln-feed } }\nsteps:\n  - { id: reopen, type: gateway.upstream.enable, autonomy: auto, with: { upstream: erp } }\n' }],
  });
  check('a playbook that loosens automatically is rejected by validation', !bad.validation.ok && JSON.stringify(bad.validation.checks).includes('must have autonomy'), bad.validation.checks.find((c) => !c.ok)?.errors?.[0]?.message);
  // proposals are pull requests on the Git host (ADR-0049): the invalid one is closed there (its check failed)
  const secrets = JSON.parse(docker('exec', 'cw-temporal', 'cat', '/data/admin/extensions-secrets.json').stdout || '{}').liquid ?? {};
  const auth = `Basic ${Buffer.from(`reviewer:${secrets.forgejo_reviewer_password}`).toString('base64')}`;
  {
    const st = await (await fetch(`http://localhost:3300/api/v1/repos/liquid/config/commits/${bad.head}/status`, { headers: { authorization: auth } })).json();
    check('on the Git host the required check liquid/validate failed', st.state === 'failure', st.state);
    await fetch(`http://localhost:3300/api/v1/repos/liquid/config/pulls/${bad.pr.number}`, { method: 'PATCH', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'closed' }) });
  }
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = String(err);
  log(String(err));
} finally {
  result.finishedAt = new Date().toISOString();
  mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/liquid/results/e2e-playbooks.json'), JSON.stringify(result, null, 2));
  log(`${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks ok`);
  process.exit(result.ok ? 0 : 1);
}

async function shot(url, name, height) {
  const { Shots } = await import('../sofa-company/shots.mjs');
  process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
  const shots = await new Shots(path.join(root, 'docs', 'images', 'liquid')).open();
  await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}${url}`, name, { width: 1500, height, wait: 3500, fullPage: true });
  await shots.close();
  log(`screenshot docs/images/liquid/${name}.png`);
}
