import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleNotFoundError } from '@temporalio/client';
import type { Principal, TaskState } from '@cw/shared';
import { TaskChat } from '../src/chat/taskChat.js';
import type { ApiDeps } from '../src/api/context.js';

const alice: Principal = { upn: 'alice@example.com', name: 'Alice', oid: 'a', roles: ['user'] } as Principal;
const bob: Principal = { upn: 'bob@example.com', name: 'Bob', oid: 'b', roles: ['user'] } as Principal;
const admin: Principal = { upn: 'root@example.com', name: 'Root', oid: 'r', roles: ['user', 'admin'] } as Principal;

const state = {
  taskId: 'task-1',
  title: 'RPG games on Steam',
  type: 'report',
  status: 'completed',
  requestedBy: { upn: alice.upn, name: alice.name, oid: alice.oid },
  createdAt: '2026-10-26T10:00:00.000Z',
  instructions: 'Check new RPG games on Steam and update the report',
  steps: [],
  decisions: [],
  notes: [],
} as unknown as TaskState;

const proposal = {
  title: 'Weekly Steam RPG check',
  instructions: 'Check new RPG games on Steam and update reports/steam-rpg.md',
  type: 'report',
  calendar: { kind: 'cron', cron: '0 9 * * 3,6' },
};

let dir: string;
let created: Array<{ scheduleId: string; action: { args: Array<{ trigger: { owner: { upn: string } } }> } }>;
let deps: ApiDeps;
let chat: TaskChat;

function modelAnswers(message: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'chat-'));
  created = [];
  deps = {
    config: {
      AGENT_ID: 'lara',
      AGENT_DISPLAY_NAME: 'Lara',
      AI_GATEWAY_BASE_URL: 'http://ai',
      AI_GATEWAY_API_KEY: 'k',
      AI_GATEWAY_MODEL: 'm',
      artifactsDir: dir,
      workspaceDir: dir,
      taskQueue: 'q',
      roles: { user: 'user', approver: 'approver', admin: 'admin' },
    },
    spend: { get: async () => undefined },
    audit: { write: vi.fn(async () => undefined) },
    temporal: {
      schedule: {
        getHandle: () => ({
          describe: async () => {
            throw new ScheduleNotFoundError('not found', 'x');
          },
        }),
        create: async (o: (typeof created)[number]) => void created.push(o),
      },
    },
  } as unknown as ApiDeps;
  chat = new TaskChat(deps);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const toolCall = (args: unknown) => ({ content: null, tool_calls: [{ function: { name: 'propose_schedule', arguments: JSON.stringify(args) } }] });

describe('schedule proposals in the task chat (ADR-0034)', () => {
  it('a proposal is only stored as pending — nothing is scheduled', async () => {
    modelAnswers(toolCall(proposal));
    const [, answer] = await chat.ask('task-1', state, alice, 'repeat this every Wednesday and Saturday');
    expect(answer.proposal).toMatchObject({ status: 'pending', requestedBy: { upn: alice.upn }, schedule: { title: proposal.title, approval: 'deviation' } });
    expect(answer.text).toContain('Weekly Steam RPG check');
    expect(created).toHaveLength(0);
    expect((await chat.list('task-1')).at(-1)?.proposal?.status).toBe('pending');
  });

  it('an invalid proposal is not stored and the agent asks back', async () => {
    modelAnswers(toolCall({ ...proposal, calendar: { kind: 'weekly', dayOfWeek: 9, hour: 9, minute: 0 } }));
    const [, answer] = await chat.ask('task-1', state, alice, 'weekly please');
    expect(answer.proposal).toBeUndefined();
    expect(answer.text).toMatch(/not valid/);
  });

  it('approval creates the schedule owned by the approver, exactly once', async () => {
    modelAnswers(toolCall(proposal));
    const [, answer] = await chat.ask('task-1', state, alice, 'repeat this');
    const decided = await chat.decideProposal('task-1', answer.id, alice, 'approve');
    expect(decided.proposal).toMatchObject({ status: 'approved', scheduleId: 'sched-lara-weekly-steam-rpg-check', decidedBy: { upn: alice.upn } });
    expect(created).toHaveLength(1);
    expect(created[0]!.action.args[0]!.trigger.owner.upn).toBe(alice.upn);
    await expect(chat.decideProposal('task-1', answer.id, alice, 'approve')).rejects.toMatchObject({ status: 409 });
    expect(created).toHaveLength(1);
    expect((await chat.list('task-1')).at(-1)?.proposal?.status).toBe('approved');
  });

  it('a second person cannot approve, an admin can, rejection schedules nothing', async () => {
    modelAnswers(toolCall(proposal));
    const [, a1] = await chat.ask('task-1', state, alice, 'repeat this');
    await expect(chat.decideProposal('task-1', a1.id, bob, 'approve')).rejects.toMatchObject({ status: 403 });
    expect(created).toHaveLength(0);
    await chat.decideProposal('task-1', a1.id, alice, 'reject');
    expect(created).toHaveLength(0);
    expect((await chat.list('task-1')).find((m) => m.id === a1.id)?.proposal?.status).toBe('rejected');

    const [, a2] = await chat.ask('task-1', state, alice, 'again');
    await chat.decideProposal('task-1', a2.id, admin, 'approve');
    expect(created).toHaveLength(1);
  });

  it('simultaneous approvals create one schedule', async () => {
    modelAnswers(toolCall(proposal));
    const [, answer] = await chat.ask('task-1', state, alice, 'repeat this');
    const results = await Promise.allSettled([chat.decideProposal('task-1', answer.id, alice, 'approve'), chat.decideProposal('task-1', answer.id, alice, 'approve')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(created).toHaveLength(1);
  });
});
