import { describe, expect, it, vi } from 'vitest';
import type { UpstreamServer } from '@cw/shared';
import { askOpa, gatewayVerdict, interpret, opaInput } from './opa.js';

const upstream: UpstreamServer = { name: 'erp', url: 'http://ontology-server:7710/erp/mcp', headers: {}, enabled: true, auth: 'static', oboFallback: 'deny', policy: 'opa' };
const input = opaInput({ agentId: 'sofa-lara', tool: 'erp__create_purchase_order', upstream, ctx: { taskId: 't-1', phase: 'run', interactive: false, requestedBy: { upn: 'stefan@x' } }, killSwitch: 'normal' });
const opa = { url: 'http://opa:8181', token: { secretRef: 'ext-liquid-opa-query-token-raw' } };
const resolve = async () => 'tok';

describe('OPA input', () => {
  it('derives the action from the tool name and carries task step and user', () => {
    expect(input).toEqual({ agent: { id: 'sofa-lara' }, user: { upn: 'stefan@x', oid: undefined }, tool: 'erp__create_purchase_order', upstream: 'erp', action: 'create_purchase_order', task: { id: 't-1', step: 'run', interactive: false }, killSwitch: 'normal' });
  });
});

describe('fail closed', () => {
  it.each([
    ['no OPA configured', undefined, undefined, /no policy engine is configured/],
    ['OPA unreachable', opa, () => Promise.reject(new Error('ECONNREFUSED')), /not reachable/],
    ['HTTP 403 (wrong token)', opa, async () => new Response('{}', { status: 403 }), /HTTP 403/],
    ['no decision (bundle not loaded)', opa, async () => new Response('{}', { status: 200 }), /no decision/],
    ['malformed decision', opa, async () => new Response('{"result":{"allow":"yes"}}', { status: 200 }), /no decision/],
  ])('%s → deny', async (_n, cfg, fetchImpl, reason) => {
    const d = await askOpa(cfg, input, resolve, { fetchImpl: fetchImpl as typeof fetch });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(reason);
  });

  it('a token that cannot be resolved denies', async () => {
    const d = await askOpa(opa, input, async () => Promise.reject(new Error('no Key Vault')), { fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(d).toMatchObject({ allow: false });
  });
});

describe('decisions', () => {
  it('posts the input with the bearer token to the gateway decision', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ result: { allow: true, reason: 'allowed', obligations: [] } }), { status: 200 }));
    const d = await askOpa(opa, input, resolve, { fetchImpl: f as unknown as typeof fetch });
    expect(d).toEqual({ allow: true, reason: 'allowed', obligations: [] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://opa:8181/v1/data/liquid/gateway/decision');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ input });
  });

  it('denials pass on their reason; obligations are allowed through and audited (enforced at object level)', () => {
    expect(gatewayVerdict(interpret(200, { result: { allow: false, reason: 'agent sofa-horst has no role', obligations: [] } }))).toEqual({ allowed: false, reason: 'agent sofa-horst has no role', obligations: [] });
    expect(gatewayVerdict(interpret(200, { result: { allow: true, reason: 'allowed', obligations: ['require_four_eyes'] } }))).toEqual({ allowed: true, reason: 'allowed', obligations: ['require_four_eyes'] });
  });
});
