import { mcpTools } from '@cw/ontology-codegen';
import type { OntologyIr } from '@cw/ontology-ir';
import { OntologyService } from './service.js';

/*
 * MCP over HTTP (stateless JSON-RPC, the same wire behaviour as the sofa mock the gateway already talks to).
 *   /onto/mcp  every action of the ontology       /erp/mcp, /crm/mcp  the parity groups (same names as the mock)
 * Tool definitions are computed from the ontology version in force (runtime IR, ADR-0048); deprecated aliases are
 * served as extra tools that run the renamed action. Each tool additionally declares the caller fields the gateway
 * fills in and hides from the model (_agent, _task, _requestedBy, apps/mcp-gateway caller.ts), so every event records
 * which agent, task and person caused it.
 */

export const GROUPS = ['onto', 'erp', 'crm'] as const;
export type Group = (typeof GROUPS)[number];

const CALLER_SCHEMA = {
  _agent: { type: 'string', description: 'Set by the gateway: calling agent' },
  _task: { type: 'string', description: 'Set by the gateway: task id' },
  _requestedBy: { type: 'string', description: 'Set by the gateway: person on whose behalf the agent acts' },
  _step: { type: 'string', description: 'Set by the gateway: task step (plan | run | fix)' },
};

export function toolsFor(ir: OntologyIr, group: Group) {
  const defs = mcpTools(ir);
  const out = defs.flatMap((t) => {
    const a = ir.actions.find((x) => x.name === t.name)!;
    const description = a.deprecated ? `DEPRECATED (${a.deprecated}). ${t.description}` : t.description;
    const tool = { name: t.name, description, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...CALLER_SCHEMA } }, annotations: t.annotations, group: t.group };
    const aliases = (a.aliases ?? []).map((al) => ({ ...tool, name: al, description: `DEPRECATED alias of ${t.name} (renamed in ontology ${ir.version}). ${t.description}` }));
    return [tool, ...aliases];
  });
  return out.filter((t) => group === 'onto' || t.group === group).map(({ group: _g, ...t }) => t);
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export async function rpc(svc: OntologyService, group: Group, msg: RpcMessage) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: `ontology-${svc.ir.name}-${group}`, version: svc.ir.version } } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolsFor(svc.ir, group) } };
    case 'tools/call': {
      const name = params?.name ?? '';
      if (!toolsFor(svc.ir, group).some((t) => t.name === name)) return { jsonrpc: '2.0', id, result: text(`Unknown tool ${name}`, true) };
      try {
        const { args, caller } = OntologyService.splitCaller(params?.arguments ?? {});
        // approvals and workflow identity never come from an agent's tool call
        delete caller.approvedBy;
        delete caller.workflow;
        const out = await svc.execute(name, args, caller);
        return { jsonrpc: '2.0', id, result: text(out.text, out.isError) };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: text(`Tool failed: ${(e as Error).message}`, true) };
      }
    }
    default:
      return id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}
