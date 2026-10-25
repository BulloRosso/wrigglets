import { describe, expect, it } from 'vitest';
import { extractWriteTargets, nextReply, type ToolDef } from './script.js';

const tools: ToolDef[] = [
  { type: 'function', function: { name: 'read', parameters: { properties: { filePath: {} } } } },
  { type: 'function', function: { name: 'write', parameters: { properties: { filePath: {}, content: {} } } } },
];

describe('mock-llm script', () => {
  it('extracts backticked paths after "write"', () => {
    const text = [
      'Execute the plan stored in `.agent/plans/t1.md`.',
      'Write the plan to `.agent/plans/t1.md` as Markdown.',
      'When finished, write a summary to `.agent/summaries/t1_run_1.md`. Do not commit.',
      'Write it to `../etc/passwd`',
    ].join('\n');
    expect(extractWriteTargets(text)).toEqual(['.agent/plans/t1.md', '.agent/summaries/t1_run_1.md']);
  });

  it('calls the write tool for each pending path, then answers', () => {
    const system = { role: 'system' as const, content: 'Working directory: /home/workspace' };
    const user = { role: 'user' as const, content: 'Write the plan to `.agent/plans/t1.md`.\nwrite a summary to `.agent/summaries/s.md`' };
    const first = nextReply([system, user], tools);
    expect(first).toMatchObject({ kind: 'tool', name: 'write', args: { filePath: '/home/workspace/.agent/plans/t1.md' } });

    const call = (p: string) => ({
      role: 'assistant' as const,
      tool_calls: [{ id: 'c', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ filePath: p, content: 'x' }) } }],
    });
    const second = nextReply([system, user, call('/home/workspace/.agent/plans/t1.md'), { role: 'tool', content: 'ok', tool_call_id: 'c' }], tools);
    expect(second).toMatchObject({ kind: 'tool', args: { filePath: '/home/workspace/.agent/summaries/s.md' } });

    const third = nextReply(
      [system, user, call('/home/workspace/.agent/plans/t1.md'), call('/home/workspace/.agent/summaries/s.md')],
      tools,
    );
    expect(third.kind).toBe('text');
  });

  it('calls a named MCP tool once in EXECUTE steps only', () => {
    const mcp: ToolDef[] = [...tools, { type: 'function', function: { name: 'gateway_demo__fx_rate' } }];
    const text = '## Your job in this step: EXECUTE\nCall the tool `demo__fx_rate` with `{"from":"EUR","to":"USD"}`.';
    const first = nextReply([{ role: 'user', content: text }], mcp);
    expect(first).toEqual({ kind: 'tool', name: 'gateway_demo__fx_rate', args: { from: 'EUR', to: 'USD' } });
    const done = { role: 'assistant' as const, tool_calls: [{ id: 'c', type: 'function' as const, function: { name: 'gateway_demo__fx_rate', arguments: '{}' } }] };
    expect(nextReply([{ role: 'user', content: text }, done], mcp).kind).toBe('text');
    expect(nextReply([{ role: 'user', content: text.replace('EXECUTE', 'INTEGRATE DELEGATED RESULTS') }], mcp).kind).toBe('text');
  });

  it('answers plainly when no tools are offered', () => {
    expect(nextReply([{ role: 'user', content: 'Generate a title' }], undefined)).toEqual({ kind: 'text', text: 'Agent task' });
  });
});
