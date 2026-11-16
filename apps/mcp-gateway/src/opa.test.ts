import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '@cw/policy-wasm';
import { decide, gatewayVerdict, opaInput } from './opa.js';

const upstream = { name: 'erp', url: 'http://x', headers: {}, enabled: true, auth: 'static' as const, oboFallback: 'deny' as const, policy: 'opa' as const };

describe('gateway policy (embedded)', () => {
  it('builds the decision input from the call', () => {
    expect(opaInput({ agentId: 'sofa-max', tool: 'erp__request_overtime', upstream, ctx: { taskId: 't-1', phase: 'run', requestedBy: { upn: 'paula@x' } }, killSwitch: 'normal' })).toEqual({
      agent: { id: 'sofa-max' },
      user: { upn: 'paula@x', oid: undefined },
      tool: 'erp__request_overtime',
      upstream: 'erp',
      action: 'request_overtime',
      task: { id: 't-1', step: 'run', interactive: false },
      killSwitch: 'normal',
    });
  });
  it('fails closed without a policy package or before it is loaded', () => {
    const input = opaInput({ agentId: 'a', tool: 'erp__x', upstream, killSwitch: 'normal' });
    expect(decide(undefined, true, input)).toMatchObject({ allow: false });
    expect(decide(new PolicyEngine(), false, input)).toMatchObject({ allow: false, reason: expect.stringMatching(/no policy package/) });
    expect(decide(new PolicyEngine(), true, input)).toMatchObject({ allow: false, reason: expect.stringMatching(/fail closed/) });
  });
  it('denials are enforced, obligations only recorded', () => {
    expect(gatewayVerdict({ allow: false, reason: 'agent sofa-horst has no role', obligations: [] })).toEqual({ allowed: false, reason: 'agent sofa-horst has no role', obligations: [] });
    expect(gatewayVerdict({ allow: true, reason: 'allowed', obligations: ['require_four_eyes'] })).toEqual({ allowed: true, reason: 'allowed', obligations: ['require_four_eyes'] });
  });
});
