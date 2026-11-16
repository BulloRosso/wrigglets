import { MCP_TOOLS } from '@cw/ontology-sofa';
import { OntologyService } from './service.js';

/*
 * MCP over HTTP (stateless JSON-RPC, the same wire behaviour as the sofa mock the gateway already talks to).
 *   /onto/mcp  every action of the ontology       /erp/mcp, /crm/mcp  the parity groups (same names as the mock)
 * Tool definitions come from the generated MCP_TOOLS. Each tool additionally declares the caller fields the gateway
 * fills in and hides from the model (_agent, _task, _requestedBy, apps/mcp-gateway caller.ts), so every event records
 * which agent, task and person caused it.
 */

export const GROUPS = ['onto', 'erp', 'crm'] as const;
export type Group = (typeof GROUPS)[number];

const CALLER_SCHEMA = {
  _agent: { type: 'string', description: 'Set by the gateway: calling agent' },
  _task: { type: 'string', description: 'Set by the gateway: task id' },
  _requestedBy: { type: 'string', description: 'Set by the gateway: person on whose behalf the agent acts' },
};

export function toolsFor(group: Group) {
  return MCP_TOOLS.filter((t) => group === 'onto' || t.group === group).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...CALLER_SCHEMA } },
    annotations: t.annotations,
  }));
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
      return { jsonrpc: '2.0', id, result: { tools: toolsFor(group) } };
    case 'tools/call': {
      const name = params?.name ?? '';
      if (!toolsFor(group).some((t) => t.name === name)) return { jsonrpc: '2.0', id, result: text(`Unknown tool ${name}`, true) };
      try {
        const { args, caller } = OntologyService.splitCaller(params?.arguments ?? {});
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
