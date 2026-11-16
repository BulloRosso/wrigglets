#!/usr/bin/env node
// Sets up the modelling agent of Liquid Enterprise (M8, ADR-0048): an agent that proposes ontology changes through the
// MCP upstream "config" (read, validate, propose) and never writes business data. Idempotent.
//   node scripts/liquid/modelling-agent.mjs [--agent sofa-modeller] [--dry-run]
// Creating the agent starts its container; it costs model tokens only when someone gives it a task.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN, Session, env, log, root, until } from '../sofa-company/lib.mjs';

const args = process.argv.slice(2);
const agent = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : 'sofa-modeller';
const dry = args.includes('--dry-run');
const skill = readFileSync(path.join(root, 'assets/liquid/modelling-skill.md'), 'utf8');
const TOOLS = ['config__read', 'config__validate', 'config__propose_change', 'config__get_proposal', 'onto__list_*', 'onto__get_*'];

const s = new Session();
await s.signIn(ADMIN, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD);
const api = (method, p, body) => s.json(method, `${ADMIN}/api${p}`, body);
const ext = await api('GET', '/extensions/liquid');
if (!ext.available) throw new Error('Liquid Enterprise is not installed (admin console → Extensions)');
const agents = await api('GET', '/agents');
const exists = agents.some((a) => (a.spec?.agentId ?? a.agentId) === agent);
log(`${agent}: ${exists ? 'exists' : 'will be created'}; tools ${TOOLS.join(', ')}`);
if (dry) process.exit(0);
if (!exists) {
  await api('POST', '/agents', { agentId: agent, displayName: 'Ontology modeller', description: 'Proposes changes to the company ontology (Liquid Enterprise); never writes business data.' });
  await until(`${agent} running`, async () => {
    const a = (await api('GET', '/agents')).find((x) => (x.spec?.agentId ?? x.agentId) === agent);
    return a?.runtime?.state === 'running' ? a : undefined;
  }, 300_000, 5000);
}
await api('PUT', `/agents/${agent}/tools`, { allowedTools: TOOLS });
await until('skill written', async () => {
  try {
    await api('PUT', `/agents/${agent}/agents-md`, { content: `# ${agent}\n\n${skill}` });
    return true;
  } catch {
    return undefined;
  }
}, 120_000, 5000);
log(`${agent} is ready: allow-list set, skill in AGENTS.md. Give it a task in its UI to propose a change.`);
