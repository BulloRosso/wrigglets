#!/usr/bin/env node
// D1 backend swap (docs/liquid-enterprise.md): points the gateway upstreams `erp` and `crm` of the sofa company at the
// Liquid Enterprise ontology server instead of the mock — same upstream names, so the agents' allow-lists and AGENTS.md
// stay valid. Prerequisites: scripts/sofa-company/setup.mjs (agents, people, upstreams) and Liquid installed.
//
//   node scripts/liquid/setup.mjs            erp/crm -> ontology server (/erp/mcp, /crm/mcp, bearer from Key Vault)
//   node scripts/liquid/setup.mjs --restore  erp/crm -> the mock (http://mcp-sofa:7660)
import { ADMIN, Session, env, log } from '../sofa-company/lib.mjs';

const restore = process.argv.includes('--restore');
const s = new Session();
await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);

const liquid = await api('GET', '/extensions/liquid');
if (!restore && !liquid.available) throw new Error('Liquid Enterprise is not installed/available (admin console → Extensions)');
const DESCRIPTION = {
  erp: 'ERP of the sofa company: factories, machines, workers, production orders, warehouse, purchasing',
  crm: 'CRM of the sofa company: customers, sales orders, campaigns, customer notices',
};
const gw = await api('GET', '/gateway');
for (const name of ['erp', 'crm']) {
  const before = gw.upstreams.find((u) => u.name === name);
  const upstream = restore
    ? { description: DESCRIPTION[name], url: `http://mcp-sofa:7660/${name}/mcp`, headers: {}, enabled: true, auth: 'static', oboFallback: 'deny' }
    : {
        description: `${DESCRIPTION[name]} (served by the Liquid Enterprise ontology server)`,
        url: `http://ontology-server:7710/${name}/mcp`,
        // the extension stored "Bearer <token>" in Key Vault for its own upstream `onto`; the parity groups reuse it
        headers: { Authorization: { secretRef: 'ext-liquid-ontology-mcp-token' } },
        enabled: true,
        auth: 'static',
        oboFallback: 'deny',
      };
  await api('PUT', `/gateway/upstreams/${name}`, upstream);
  log(`${name}: ${before?.url ?? '(new)'} → ${upstream.url}`);
}
// the gateway caches tool lists for 60 s; a fresh list confirms the switch
const tools = (await api('GET', '/gateway')).tools.filter((t) => /^(erp|crm)__/.test(t.name));
log(`gateway sees ${tools.length} erp/crm tools${tools.length ? '' : ' (tool list refreshes within 60 s)'}`);
if (!restore) log('backend swapped: run node scripts/sofa-company/run.mjs --backend onto --no-shots --prefix onto-1');
