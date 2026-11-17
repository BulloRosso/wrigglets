// Shared helpers of the Liquid end-to-end scripts and scenarios: checks with a results file, an admin session, the
// Git host as reviewer, the enterprise core's internal API, SQL on the event log, and MCP tool calls as an agent
// (through the gateway, from inside the agent's container — the same path a model's tool call takes).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, sleep, until } from '../sofa-company/lib.mjs';

export { ADMIN, env, log, root, sleep, until };

export const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, maxBuffer: 64 * 1024 * 1024 });

/** Checks that throw on failure and end up in scripts/liquid/results/<name>.json with timings. */
export function results(name) {
  const r = { startedAt: new Date().toISOString(), checks: [], metrics: {} };
  const t0 = Date.now();
  return {
    r,
    check(label, ok, detail) {
      r.checks.push({ name: label, ok: !!ok, detail, atMs: Date.now() - t0 });
      log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
      if (!ok) throw new Error(`check failed: ${label}`);
    },
    metric(key, value) {
      r.metrics[key] = value;
      log(`metric ${key} = ${JSON.stringify(value)}`);
    },
    write(ok, error) {
      Object.assign(r, { ok, error: error ? String(error) : undefined, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0 });
      mkdirSync(path.join(root, 'scripts/liquid/results'), { recursive: true });
      writeFileSync(path.join(root, 'scripts/liquid/results', `${name}.json`), JSON.stringify(r, null, 2));
      log(`result: scripts/liquid/results/${name}.json (${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks ok)`);
    },
  };
}

export async function adminSession() {
  const s = new Session();
  await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
  return { s, api: (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body) };
}

/** The Git host as the reviewer account (its password is an extension secret of the control plane). */
export function gitHost() {
  const secrets = JSON.parse(docker('exec', 'cw-temporal', 'cat', '/data/admin/extensions-secrets.json').stdout || '{}').liquid ?? {};
  const call = async (method, p, body) => {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(`http://localhost:3300/api/v1${p}`, { method, headers: { authorization: `Basic ${Buffer.from(`reviewer:${secrets.forgejo_reviewer_password}`).toString('base64')}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        if (r.status >= 300) throw Object.assign(new Error(`Git host ${method} ${p} → ${r.status} ${text.slice(0, 200)}`), { status: r.status });
        return text ? JSON.parse(text) : null;
      } catch (err) {
        if (err.status || i >= 4) throw err;
        await sleep(1000 * (i + 1));
      }
    }
  };
  return {
    call,
    /** The reviewer approves and merges the pull request of a proposal. */
    async approveAndMerge(api, proposalId, comment = 'approved') {
      const p = await until(`pull request of ${proposalId}`, async () => {
        const x = await api('GET', `/liquid/proposals/${proposalId}`);
        return x.pr ? x : undefined;
      }, 90_000, 2000);
      await call('POST', `/repos/liquid/config/pulls/${p.pr.number}/reviews`, { event: 'APPROVED', body: comment });
      // right after opening, the host may still compute mergeability ("Please try again later"): wait and retry
      for (let i = 0; ; i++) {
        try {
          await call('POST', `/repos/liquid/config/pulls/${p.pr.number}/merge`, { Do: 'merge', merge_message_field: `${p.title} (proposal ${p.id})` });
          break;
        } catch (err) {
          if (!/try again later/i.test(String(err)) || i >= 15) throw err;
          await sleep(2000);
        }
      }
      return p;
    },
    close: (n) => call('PATCH', `/repos/liquid/config/pulls/${n}`, { state: 'closed' }),
    status: (sha) => call('GET', `/repos/liquid/config/commits/${sha}/status`).then((x) => x?.state),
  };
}

/** The enterprise core's REST/internal API with its internal token (from inside its container). */
export function core(method, p, body) {
  const script = `let b = ''; process.stdin.on('data', (c) => (b += c)).on('end', () => fetch('http://127.0.0.1:7710' + process.argv[1], { method: process.argv[2], headers: { authorization: 'Bearer ' + process.env.INTERNAL_TOKEN, 'content-type': 'application/json' }, body: b || undefined })
    .then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }))).catch((e) => { console.error(String(e)); process.exit(1); }))`;
  const r = spawnSync('docker', ['exec', '-i', 'cw-ext-liquid-ontology-server', 'node', '-e', script, p, method], { encoding: 'utf8', input: body ? JSON.stringify(body) : '', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (r.status !== 0) throw new Error(`core ${method} ${p}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

export const sql = (q) => docker('exec', 'cw-ext-liquid-ontology-db', 'psql', '-U', 'onto', '-d', 'onto', '-tAc', q).stdout.trim();

/** An MCP tools/call as an agent through the gateway (no model involved: the scenario plays the agent's part). */
export function agentTool(agent, name, args) {
  const script = `let b = ''; process.stdin.on('data', (c) => (b += c)).on('end', () => fetch(process.env.MCP_GATEWAY_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.MCP_GATEWAY_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: b })
    .then(async (r) => { process.stdout.write(await r.text()); }).catch((e) => { console.error(String(e)); process.exit(1); }))`;
  const r = spawnSync('docker', ['exec', '-i', `cw-agent-${agent}`, 'node', '-e', script], { encoding: 'utf8', input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${agent} ${name}: ${r.error ?? r.stderr}`);
  const out = JSON.parse(r.stdout.replace(/^event: message\s*data: /m, '').trim());
  return { text: out.result?.content?.[0]?.text ?? JSON.stringify(out.error ?? out), isError: !!out.result?.isError || !!out.error };
}

/** Grants an agent extra tools for the scenario (a console edit); returns a function that restores the list. */
export async function grantTools(api, agent, tools) {
  const original = (await api('GET', `/agents/${agent}/tools`)).allowedTools;
  await api('PUT', `/agents/${agent}/tools`, { allowedTools: [...new Set([...original, ...tools])] });
  return () => api('PUT', `/agents/${agent}/tools`, { allowedTools: original });
}

/** Waits until gateway and core run the current policy package (optionally a revision other than `not`). */
export async function policyConverged(api, not) {
  return until('policy converged', async () => {
    const st = await api('GET', '/liquid/policy');
    const rev = st.bundle?.revision;
    return rev && rev !== not && ['gateway', 'core'].every((c) => st.consumers?.[c]?.revision === rev) ? rev : undefined;
  }, 60_000, 1000);
}

/** Back to a calm baseline: open playbook runs cancelled and undone by hand, holds released, erp enabled. */
export async function calm(api) {
  for (const r of await api('GET', '/liquid/playbooks/runs')) {
    if (!['running', 'awaiting_approval'].includes(r.state)) continue;
    await api('POST', `/liquid/playbooks/runs/${r.runId}/cancel`, { reason: 'scenario pre-clean' }).catch(() => undefined);
    await api('POST', '/liquid/processes/release', { ref: r.runId }).catch(() => undefined);
  }
  for (const o of (await api('GET', '/liquid/policy')).overlays.filter((x) => x.source?.startsWith('playbook:'))) await api('DELETE', `/liquid/policy/overlays/${o.id}`);
  for (const u of (await api('GET', '/gateway')).upstreams.filter((x) => ['erp', 'crm'].includes(x.name) && !x.enabled)) await api('PUT', `/gateway/upstreams/${u.name}`, { ...u, enabled: true });
  // a kill switch raised by an earlier run is reset by the operator (logged), so the scenario starts clean
  const ks = (await api('GET', '/killswitch')).state ?? {};
  if (ks.global?.level && ks.global.level !== 'normal') await api('PUT', '/killswitch', { level: 'normal', reason: 'scenario pre-clean' });
  for (const [agent, e] of Object.entries(ks.agents ?? {})) if (e.level !== 'normal') await api('PUT', `/agents/${agent}/killswitch`, { level: 'normal', reason: 'scenario pre-clean' });
  // removed overlays are gone only once gateway and core run the new policy package (polled every 5 s)
  await until('policy converged', async () => {
    const st = await api('GET', '/liquid/policy');
    const rev = st.bundle?.revision;
    return rev && !st.overlays.some((o) => o.source?.startsWith('playbook:')) && ['gateway', 'core'].every((c) => st.consumers?.[c]?.revision === rev) ? true : undefined;
  }, 60_000, 1000);
}
