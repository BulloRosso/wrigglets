import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { hideCallerParams, withCaller } from './caller.js';

const propose: Tool = {
  name: 'wiki__propose_edit',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, _agent: { type: 'string' }, _task: { type: 'string' } }, required: ['path', '_agent'] },
};
const plain: Tool = { name: 'erp__get_kpi', inputSchema: { type: 'object', properties: {} } };

describe('verified caller parameters', () => {
  it('hides them from the model', () => {
    const t = hideCallerParams(propose);
    expect(Object.keys(t.inputSchema.properties ?? {})).toEqual(['path']);
    expect(t.inputSchema.required).toEqual(['path']);
    expect(hideCallerParams(plain)).toBe(plain);
  });

  it('sets them from the gateway and replaces what the model sent', () => {
    expect(withCaller(propose, { path: 'a.md', _agent: 'sofa-max', _task: 'forged' }, { agentId: 'sofa-lara', taskId: 'task-1' })).toEqual({ path: 'a.md', _agent: 'sofa-lara', _task: 'task-1' });
  });

  it('never lets a model set them on tools that do not declare them', () => {
    expect(withCaller(plain, { _agent: 'sofa-max', x: 1 }, { agentId: 'sofa-lara' })).toEqual({ x: 1 });
  });
});
