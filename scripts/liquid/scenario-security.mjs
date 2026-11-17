#!/usr/bin/env node
// D2 — New security risk (M10, plan §2). A vulnerability is reported for the ERP connector (supplier data, bank-like
// payment-critical orders). The platform contains it automatically, an agent proposes the fix with shadow-replay
// evidence, the reviewer merges the fix on the Git host, the security owner approves the recovery, and everything
// is back to baseline — with every step as evidence (results file, event log, Temporal, Git host, mail outbox).
//
// What is real: the platform (gateway, policy engine, enterprise core, Temporal workflows, Forgejo, reconciler, mail
// outbox). What is scripted: the alert feed, the agent's part (its MCP tool calls are made by this script through
// the gateway as the agent — no model), and the people (reviewer and security owner act through their APIs).
import { ADMIN, adminSession, agentTool, calm, core, gitHost, grantTools, log, results, sleep, sql, until } from './lib.mjs';

const R = results('d2-security');
const { check, metric } = R;
const UP = 'erp';
const OWNER = 'security@sofaworks.example';
const AGENT = 'sofa-max'; // plays the platform agent: proposes the fixed configuration through its config tools
const ALERT = { source: 'vuln-feed', severity: 'critical', upstream: UP, summary: 'CVE-2026-4711: the ERP connector leaks supplier bank details (D2)', reference: 'https://vuln-feed.example/CVE-2026-4711' };
let restoreTools;

try {
  const { api } = await adminSession();
  await calm(api);
  const runOf = async (id) => (await api('GET', '/liquid/playbooks/runs')).find((r) => r.runId === id);
  let pos = [];
  const snapshot = async () => {
    const gw = await api('GET', '/gateway');
    const pol = await api('GET', '/liquid/policy');
    const pr = await api('GET', '/liquid/processes');
    return {
      erp: gw.upstreams.find((u) => u.name === UP),
      overlays: pol.overlays.map((o) => o.id).sort().join(','),
      held: pr.running.filter((r) => r.hold?.held).map((r) => r.workflowId).sort(),
      heldOrders: pos.filter((p) => pr.running.some((r) => r.hold?.held && r.objects.includes(`PurchaseOrder:${p}`))),
    };
  };

  // the playbook in force (config repository) notifies the security owner; if not yet, the owner adds it (reviewed)
  const PB = 'playbooks/third-party-upstream-vulnerability.yaml';
  const pb = (await api('GET', `/liquid/config/file?path=${PB}`)).content;
  if (!pb.includes(OWNER)) {
    // line by line: the `with:` line of the notify step gets the recipient
    const ls = pb.split('\n');
    const at = ls.findIndex((l, i) => l.trim().startsWith('with:') && ls.slice(Math.max(0, i - 3), i).some((x) => x.includes('type: notify')));
    ls[at] = ls[at].replace(/ \}\s*$/, `, to: [${OWNER}] }`);
    const next = ls.join('\n');
    const p = await api('POST', '/liquid/proposals', { title: 'Notify the security owner when an upstream is contained (D2)', reason: 'The security owner must hear about every containment at once.', changes: [{ path: PB, content: next }] });
    await gitHost().approveAndMerge(api, p.id, 'security owner subscribes (D2)');
    await until('playbook with the security owner in force', async () => (JSON.stringify((await api('GET', '/liquid/playbooks')).playbooks).includes(OWNER) ? true : undefined), 90_000, 2000);
    log('playbook updated through a reviewed proposal: notify the security owner');
  }

  // business going on: purchase orders in their release window (payment-critical, suppliers' bank details)
  await api('POST', '/liquid/sim/reset');
  pos = ['S-BALTIC', 'S-NORDHOLZ'].map((supplierId, i) => JSON.parse(core('POST', '/actions/create_purchase_order', { supplierId, sku: 'BEAM-PINE-80', quantity: 2000 + i * 500, _requestedBy: 'stefan.lang@sofaworks.example' }).body.result).id);
  await until('release workflows running', async () => ((await api('GET', '/liquid/processes')).running.filter((r) => pos.some((p) => r.objects.includes(`PurchaseOrder:${p}`))).length === 2 ? true : undefined), 30_000, 1000);
  const base = await snapshot();
  check('baseline: erp enabled, no overlay, no hold; two purchase orders in their release window', base.erp?.enabled && base.overlays === '' && base.held.length === 0, { orders: pos });
  const lara0 = agentTool('sofa-lara', 'erp__list_suppliers', {});
  check('an agent reads supplier data through the ERP connector', !lara0.isError, lara0.text.slice(0, 60));
  const seq0 = Number(sql('SELECT coalesce(max(seq),0) FROM events'));

  // 1. the alert
  const t0 = Date.now();
  const sent = await api('POST', '/liquid/playbooks/alerts', ALERT);
  check('the alert starts the playbook "Vulnerable third-party upstream"', sent.runs.length === 1 && sent.runs[0].playbook === 'third-party-upstream-vulnerability', sent.runs);
  const runId = sent.runs[0].runId;

  // 2. automatic containment
  const waiting = await until('contained, waiting for a person', async () => {
    const r = await runOf(runId);
    return r?.state === 'awaiting_approval' ? r : undefined;
  }, 120_000, 1000);
  metric('containment_seconds', Math.round((Date.now() - t0) / 1000));
  const mid = await snapshot();
  const steps = Object.fromEntries(waiting.steps.map((s) => [s.id, s]));
  check('upstream erp disabled automatically', mid.erp && !mid.erp.enabled);
  check('policy overlay: four eyes on every write action the upstream reaches (blast radius from the ontology)', mid.overlays !== '' && waiting.blast.writeActions.includes('create_purchase_order'), { writeActions: waiting.blast.writeActions.length, classes: waiting.blast.classes.length });
  check('the release workflows of the affected purchase orders are held', mid.heldOrders.length === pos.length, { heldOrders: mid.heldOrders, heldWorkflows: mid.held.length });
  const lara1 = agentTool('sofa-lara', 'erp__list_suppliers', {});
  check('agents can no longer reach the ERP connector', lara1.isError, lara1.text.slice(0, 120));
  const since = new Date(t0 - 1000).toISOString();
  const mail = await until('mail to the security owner', async () => (await api('GET', '/mail')).mails.find((m) => m.at >= since && m.to.includes(OWNER)), 20_000, 1000);
  check('the security owner is notified (mail outbox)', !!mail, mail?.subject);
  check('shadow replay of the last 7 days with the candidate policy is part of the run', /replayed \d+ events/.test(steps.replay?.summary ?? ''), steps.replay?.summary);
  check('restore (loosening) waits for a person in the approvals inbox', steps.restore.state === 'awaiting_approval' && (await api('GET', '/liquid/inbox')).some((i) => i.kind === 'playbook-step' && i.detail?.effect?.runId === runId));

  // 3. the agent proposes the fix, with the replay as evidence
  restoreTools = await grantTools(api, AGENT, ['config__read', 'config__propose_change', 'config__get_proposal']);
  await until('gateway lists config tools for the agent', async () => (agentTool(AGENT, 'config__read', { path: 'gateway/upstreams.yaml' }).isError ? undefined : true), 120_000, 5000);
  const current = { content: agentTool(AGENT, 'config__read', { path: 'gateway/upstreams.yaml' }).text }; // the file as the agent reads it
  // the upstream entry of erp, line by line: set its description to the pinned, patched build
  const lines = current.content.split('\n');
  const nameAt = lines.indexOf('    name: erp');
  let first = nameAt;
  while (first > 0 && !lines[first].startsWith('  - ')) first--;
  let last = nameAt;
  while (last + 1 < lines.length && lines[last + 1].startsWith('    ')) last++;
  const entry = lines.slice(first, last + 1).map((l, i) => (i === 0 ? l.replace(/^ {2}- /, '    ') : l)).filter((l) => !l.startsWith('    description:'));
  const fixed = [...lines.slice(0, first), '  - description: "ERP connector of the sofa company, pinned to the patched build 2.4.1 (CVE-2026-4711)"', ...entry, ...lines.slice(last + 1)].join('\n');
  check('the fix keeps erp disabled (the agent may not loosen; restore is the person’s decision)', fixed !== current.content && /name: erp/.test(fixed) && /patched build 2\.4\.1/.test(fixed));
  const replay = core('POST', '/internal/shadow/replay', { windowMs: 7 * 86_400_000 }).body;
  const prop = JSON.parse(agentTool(AGENT, 'config__propose_change', { title: 'Pin the ERP connector to the patched build (CVE-2026-4711)', reason: `Fix for ${ALERT.summary}. The patched connector build 2.4.1 is pinned; the upstream stays disabled until the security owner restores it.`, evidence: JSON.stringify({ shadowReplay: { events: replay.events, diverged: replay.diverged, blocked: replay.blocked, hash: replay.hash }, advisory: ALERT.reference }), changes: [{ path: 'gateway/upstreams.yaml', content: fixed }] }).text);
  check('the agent’s fix is a validated proposal with shadow-replay evidence', prop.valid && !!prop.id, { id: prop.id, replay: { events: replay.events, diverged: replay.diverged } });

  // 4. the reviewer merges the fix on the Git host; the security owner approves the recovery
  const g = gitHost();
  const fixPr = await g.approveAndMerge(api, prop.id, 'fix reviewed by the security owner (D2)');
  await until('fix merged and applied', async () => ((await api('GET', `/liquid/proposals/${prop.id}`)).status === 'approved' ? true : undefined), 60_000, 2000);
  check('the fix is merged on the Git host (pull request, required check, reviewer)', true, fixPr.pr.url);
  const tR = Date.now();
  const approval = (await api('GET', '/liquid/inbox')).find((i) => i.kind === 'playbook-step' && i.detail?.effect?.runId === runId);
  await api('POST', `/liquid/approvals/${approval.id}/decide`, { decision: 'approve', comment: 'patched connector deployed and verified (D2)' });
  const done = await until('restored', async () => {
    const r = await runOf(runId);
    return r?.state === 'completed' ? r : undefined;
  }, 120_000, 2000);
  metric('restore_seconds_after_approval', Math.round((Date.now() - tR) / 1000));
  await sleep(1500);
  const end = await snapshot();
  check('after the approval everything is back to baseline: erp enabled, overlay gone, workflows released', end.erp?.enabled && end.overlays === '' && end.held.length === 0, done.steps.find((s) => s.id === 'restore')?.summary);
  check('the fix stays: the upstream carries the patched build', /patched build 2\.4\.1/.test(end.erp?.description ?? ''), end.erp?.description);
  const lara2 = agentTool('sofa-lara', 'erp__list_suppliers', {});
  check('agents reach the ERP connector again', !lara2.isError);

  // 5. learn: incident recorded; an automatic-remediation playbook is refused by the tighten-only rule
  const evs = sql(`SELECT string_agg(type, ',' ORDER BY seq) FROM events WHERE seq > ${seq0} AND (object_id = '${runId}' OR type = 'IncidentRecorded')`);
  check('the incident and every step are in the event log (one source of truth)', /PlaybookRunStarted/.test(evs) && /PlaybookStepExecuted/.test(evs) && /IncidentRecorded/.test(evs), evs.split(',').length + ' events');
  const auto = JSON.parse(agentTool(AGENT, 'config__propose_change', { title: 'Restore automatically when the replay is clean (D2)', reason: 'Faster recovery after clean shadow replays.', changes: [{ path: 'playbooks/auto-remediation.yaml', content: 'id: auto-remediation\nversion: 1\ntrigger: { kind: alert, match: { source: vuln-feed } }\nsteps:\n  - { id: replay, type: shadow.replay, autonomy: auto, with: { window: 7d } }\n  - { id: restore, type: restore, autonomy: auto }\n' }] }).text);
  check('a playbook that would loosen automatically (even after a clean replay) is invalid: tighten-only stays', !auto.valid, (auto.problems ?? []).map((x) => (typeof x === 'string' ? x : x.message ?? JSON.stringify(x))).join('; ').slice(0, 200));
  if (auto.id) {
    const p = await api('GET', `/liquid/proposals/${auto.id}`);
    if (p.pr) await g.close(p.pr.number);
  }
  metric('events_written', Number(sql('SELECT coalesce(max(seq),0) FROM events')) - seq0);
  metric('evidence', { run: runId, fixPullRequest: fixPr.pr.url, temporal: `namespace business, workflow PlaybookRun-${runId}`, adminUrl: `${ADMIN}/liquid/playbooks` });
  R.write(true);
} catch (err) {
  log(String(err));
  R.write(false, err);
  process.exitCode = 1;
} finally {
  await restoreTools?.().catch(() => undefined);
}
