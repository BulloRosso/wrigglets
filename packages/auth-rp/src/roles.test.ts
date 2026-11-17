import { describe, expect, it } from 'vitest';
import { entraIssuer, parseRoleMap, roleMapper } from './roles.js';

// claims as Entra ID issues them in an ID token (v2.0) for an app with app roles and group claims
const entra = {
  aud: '6b1f…client',
  iss: 'https://login.microsoftonline.com/0b4c2e7a-1111-4222-8333-944455556666/v2.0',
  oid: '00000000-0000-0000-0000-00000000a11c',
  preferred_username: 'alice@contoso.example',
  name: 'Alice',
  roles: ['Platform.Admin', 'Approvers'],
  groups: ['2f6c0d4e-7777-4888-9999-aaaabbbbcccc'],
};

describe('role mapping (Entra claims)', () => {
  it('without a map the roles claim is used as it is', () => {
    expect(roleMapper()(entra)).toEqual(['Platform.Admin', 'Approvers']);
  });
  it('maps app-role values and group ids; unmapped role values pass through', () => {
    const m = roleMapper('Approvers=Agent.Approver; 2f6c0d4e-7777-4888-9999-aaaabbbbcccc=Agent.User,Agent.Approver');
    expect(m(entra).sort()).toEqual(['Agent.Approver', 'Agent.User', 'Platform.Admin']);
  });
  it('a user without roles or mapped groups gets no role (sign-in is then refused by requiredRole)', () => {
    expect(roleMapper('Admins=Platform.Admin')({ ...entra, roles: undefined, groups: ['other'] })).toEqual([]);
  });
  it('ignores non-string claim values and groups overage', () => {
    expect(roleMapper('x=Agent.User')({ roles: [1, 'x'], _claim_names: { groups: 'src1' } } as never)).toEqual(['Agent.User']);
  });
  it('rejects malformed maps', () => {
    expect(() => parseRoleMap('Admins')).toThrow(/source=Role/);
    expect(() => parseRoleMap('Admins=')).toThrow(/names no role/);
  });
  it('builds the single-tenant issuer and refuses domain names', () => {
    expect(entraIssuer('0b4c2e7a-1111-4222-8333-944455556666')).toBe('https://login.microsoftonline.com/0b4c2e7a-1111-4222-8333-944455556666/v2.0');
    expect(() => entraIssuer('contoso.onmicrosoft.com')).toThrow(/GUID/);
  });
});
