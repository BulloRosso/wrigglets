import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/*
 * Verified caller identity for upstream tools. An upstream tool that declares the parameters `_agent`, `_task` and/or
 * `_requestedBy` in its input schema gets them from the gateway, which knows who calls (the agent's token) and for which
 * task. The model neither sees these parameters nor can it set them: they are removed from the tool list, and whatever
 * the model sends under these names is replaced. Used by the company wiki to attach a verified author to a proposal.
 */

export const CALLER_PARAMS = ['_agent', '_task', '_requestedBy'] as const;
type CallerParam = (typeof CALLER_PARAMS)[number];

const declared = (tool: Tool | undefined): CallerParam[] => CALLER_PARAMS.filter((p) => !!(tool?.inputSchema?.properties as Record<string, unknown> | undefined)?.[p]);

/** The tool as the model sees it: without the parameters the platform fills in. */
export function hideCallerParams(tool: Tool): Tool {
  const hidden = declared(tool);
  if (!hidden.length) return tool;
  const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).filter(([k]) => !(hidden as string[]).includes(k)));
  const required = (tool.inputSchema.required ?? []).filter((k) => !(hidden as string[]).includes(k));
  return { ...tool, inputSchema: { ...tool.inputSchema, properties, ...(required.length ? { required } : { required: undefined }) } };
}

/** Arguments for the upstream: model-supplied caller parameters are dropped; declared ones are set from the verified context. */
export function withCaller(tool: Tool | undefined, args: Record<string, unknown>, caller: { agentId: string; taskId?: string; requestedBy?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const p of CALLER_PARAMS) delete out[p];
  for (const p of declared(tool)) {
    const v = p === '_agent' ? caller.agentId : p === '_task' ? caller.taskId : caller.requestedBy;
    if (v) out[p] = v;
  }
  return out;
}
