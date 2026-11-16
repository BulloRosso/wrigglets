import { enumOf, type IrInput, type OntologyIr } from '@cw/ontology-ir';
import { header, js } from './util.js';

/*
 * MCP tool definitions per action: name, description, JSON input schema, readOnlyHint/destructiveHint, group.
 * Groups: the action's mcp_group (erp/crm, parity with the mock in M3) — every tool is also served under `onto`.
 * The input schema follows the mock's conventions (plain object schema, enums where the action declares them).
 */

export interface McpToolDef {
  name: string;
  group: string | null;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
}

function jsonSchema(ir: OntologyIr, f: IrInput): Record<string, unknown> {
  let s: Record<string, unknown>;
  if (f.range === 'json') s = { type: 'object' };
  else if (f.rangeKind === 'enum') s = { type: 'string', enum: enumOf(ir, f.range)!.values.map((v) => v.value) };
  else if (f.rangeKind === 'class') s = { type: 'string' };
  else s = { type: { integer: 'integer', float: 'number', boolean: 'boolean' }[f.range] ?? 'string', ...(f.range === 'date' ? { format: 'date' } : {}) };
  if (f.enum?.length) s.enum = f.enum;
  if (f.multivalued) s = { type: 'array', items: s };
  if (f.description) s.description = f.description;
  return s;
}

export function mcpTools(ir: OntologyIr): McpToolDef[] {
  return ir.actions.map((a) => ({
    name: a.name,
    group: a.mcpGroup ?? null,
    description: a.description,
    inputSchema: { type: 'object', properties: Object.fromEntries(a.input.map((f) => [f.name, jsonSchema(ir, f)])), required: a.input.filter((f) => f.required).map((f) => f.name) },
    annotations: a.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: a.destructive },
  }));
}

export function genMcp(ir: OntologyIr): string {
  return `${header(ir, '//')}// MCP tool definitions (served by the ontology server under /onto/mcp and, for parity, /<group>/mcp)\nexport const MCP_TOOLS = ${js(mcpTools(ir))} as const;\n\nexport type McpToolName = (typeof MCP_TOOLS)[number]['name'];\n`;
}
