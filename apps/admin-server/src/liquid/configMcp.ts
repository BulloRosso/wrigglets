import { ConfigError, type ConfigRepoService } from './configRepo.js';

/*
 * MCP upstream "config" (ADR-0046), served by the control plane at /internal/liquid/config/mcp: agents read the desired
 * state and propose changes; a person reviews and decides in the admin console. Stateless JSON-RPC like the other
 * upstreams; the gateway fills the caller fields (_agent, _task, _requestedBy) and hides them from the model.
 */

const CALLER_SCHEMA = {
  _agent: { type: 'string', description: 'Set by the gateway: calling agent' },
  _task: { type: 'string', description: 'Set by the gateway: task id' },
  _requestedBy: { type: 'string', description: 'Set by the gateway: person on whose behalf the agent acts' },
};

export const CONFIG_TOOLS = [
  {
    name: 'read',
    description: 'Read the platform configuration (desired state in Git, branch main). Without path: list all files. With path: the file content (YAML/Rego). Files: gateway/upstreams.yaml, gateway/allow-lists.yaml, gateway/limits.yaml, safety/rules.yaml, agents/<id>.yaml, policies/liquid/*, ontology/<domain>/*.yaml, playbooks/*.yaml, OWNERS.yaml.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path, e.g. gateway/allow-lists.yaml' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'propose_change',
    description: 'Propose a change of the platform configuration. Give the complete new content of each changed file (read it first), a short title and the reason. The change is validated immediately and applied only after the owners approve it in the admin console. Returns the proposal id and the validation result.',
    inputSchema: {
      type: 'object',
      required: ['title', 'reason', 'changes'],
      properties: {
        title: { type: 'string', description: 'One line, e.g. "sofa-max may list suppliers"' },
        reason: { type: 'string', description: 'Why the change is needed' },
        evidence: { type: 'string', description: 'Optional: what you observed (error messages, task ids, numbers)' },
        migration_note: { type: 'string', description: 'Required for a breaking ontology change: what happens to existing data and callers' },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: ['string', 'null'], description: 'Complete new file content; null deletes the file' } }, additionalProperties: false },
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'validate',
    description: 'Check a configuration change without proposing it: schemas, secrets, ontology compile, compatibility class (patch / minor / major) against the running ontology, data check against the existing objects, policy tests. Use it before propose_change; give the complete new content of each file.',
    inputSchema: {
      type: 'object',
      required: ['changes'],
      properties: {
        changes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: ['string', 'null'] } }, additionalProperties: false } },
        migration_note: { type: 'string', description: 'For a breaking ontology change' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_proposal',
    description: 'Status of a configuration proposal (pending, approved, rejected, conflict), its validation and the decision comment. Without id: your recent proposals.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
].map((t) => ({ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...CALLER_SCHEMA } } }));

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

async function call(repo: ConfigRepoService, name: string, a: Record<string, unknown>, onProposal?: (id: string, agent: string) => void) {
  const agent = str(a._agent);
  if (!agent) return text('caller unknown: config tools are only available through the gateway', true);
  try {
    if (name === 'read') {
      const r = await repo.read(str(a.path));
      return text('files' in r ? r.files.join('\n') : r.content);
    }
    if (name === 'propose_change') {
      const changes = Array.isArray(a.changes) ? (a.changes as Array<{ path?: unknown; content?: unknown }>).map((c) => ({ path: String(c.path ?? ''), content: c.content === null ? null : String(c.content ?? '') })) : [];
      const p = await repo.propose({ title: String(a.title ?? ''), reason: String(a.reason ?? ''), evidence: str(a.evidence), migrationNote: str(a.migration_note), changes, author: { kind: 'agent', id: agent, user: str(a._requestedBy), task: str(a._task) } });
      onProposal?.(p.id, agent);
      const failed = p.validation.checks.filter((c) => !c.ok);
      return text(
        JSON.stringify({
          id: p.id,
          status: p.status,
          valid: p.validation.ok,
          problems: failed.map((c) => ({ check: c.name, detail: c.detail, errors: c.errors?.slice(0, 10) })),
          approvers: p.owners,
          compatibility: p.compat ? { level: p.compat.level, suggestedVersion: p.compat.suggestedVersion, findings: p.compat.findings.slice(0, 20) } : undefined,
          next: p.validation.ok ? 'Waits for approval in the admin console (Liquid enterprise → Proposals). Check with get_proposal.' : 'Not valid: fix the problems and propose again; an invalid proposal cannot be approved.',
        }),
      );
    }
    if (name === 'validate') {
      const changes = Array.isArray(a.changes) ? (a.changes as Array<{ path?: unknown; content?: unknown }>).map((c) => ({ path: String(c.path ?? ''), content: c.content === null ? null : String(c.content ?? '') })) : [];
      if (!changes.length) return text('changes are required', true);
      return text(JSON.stringify(await repo.validateChanges(changes, str(a.migration_note))));
    }
    if (name === 'get_proposal') {
      const id = str(a.id);
      if (!id) return text(JSON.stringify(repo.list({ agent }).slice(0, 10).map((p) => ({ id: p.id, title: p.title, status: p.status, valid: p.validation.ok, decidedBy: p.decidedBy, comment: p.comment }))));
      const p = await repo.get(id);
      if (p.author.id !== agent) return text(`proposal ${id} belongs to another agent`, true);
      return text(JSON.stringify({ id: p.id, title: p.title, status: p.status, valid: p.validation.ok, checks: p.validation.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })), decidedBy: p.decidedBy, decidedAt: p.decidedAt, comment: p.comment, mergedAs: p.mergedAs }));
    }
    return text(`Unknown tool ${name}`, true);
  } catch (err) {
    return text(err instanceof ConfigError ? err.message : `failed: ${(err as Error).message}`, true);
  }
}

export async function configRpc(repo: ConfigRepoService, msg: RpcMessage, onProposal?: (id: string, agent: string) => void) {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: msg.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'liquid-config', version: '0.1.0' } });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: CONFIG_TOOLS });
    case 'tools/call': {
      const name = msg.params?.name ?? '';
      if (!CONFIG_TOOLS.some((t) => t.name === name)) return ok(text(`Unknown tool ${name}`, true));
      return ok(await call(repo, name, msg.params?.arguments ?? {}, onProposal));
    }
    default:
      if (msg.id === undefined) return undefined;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}
