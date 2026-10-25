import Provider, { type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import type { Config } from './config.js';
import { createAdapterClass } from './adapter.js';
import { errorPage, logoutPage, signedOutPage } from './pages.js';
import { rolesForClient, type Store } from './store.js';

/** node-oidc-provider configuration (authorization code + PKCE, confidential clients only). */
export function createProvider(config: Config, store: Store, secrets: { jwks: Configuration['jwks']; cookieKeys: string[] }): Provider {
  const configuration: Configuration = {
    adapter: createAdapterClass(store),
    jwks: secrets.jwks,
    cookies: { keys: secrets.cookieKeys },
    clientBasedCORS: () => false,
    pkce: { required: () => true },
    // Put profile/email/roles claims into the ID token (the RP does not call userinfo).
    conformIdTokenClaims: false,
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name', 'preferred_username', 'oid', 'roles'],
    },
    extraClientMetadata: { properties: ['cw_kind', 'cw_agent_id'] },
    ttl: {
      Session: config.SESSION_TTL_HOURS * 3600,
      Grant: config.SESSION_TTL_HOURS * 3600,
      Interaction: 3600,
      AuthorizationCode: 60,
      IdToken: 3600,
      AccessToken: 3600,
    },
    async findAccount(ctx: KoaContextWithOIDC, sub: string) {
      const user = store.findUser(sub);
      if (!user || user.disabled) return undefined;
      return {
        accountId: user.id,
        async claims() {
          const client = ctx.oidc.client as unknown as { cw_kind?: 'agent' | 'admin' | 'custom'; cw_agent_id?: string } | undefined;
          return {
            sub: user.id,
            email: user.email,
            email_verified: true,
            name: user.name,
            preferred_username: user.email,
            oid: user.id,
            roles: rolesForClient(user, client ? { kind: client.cw_kind ?? 'custom', agentId: client.cw_agent_id } : undefined),
          };
        },
      };
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: async (ctx, form) => {
          ctx.body = logoutPage(form);
        },
        postLogoutSuccessSource: async (ctx) => {
          ctx.body = signedOutPage(ctx.oidc.client?.clientName ?? undefined);
        },
      },
    },
    async renderError(ctx, out) {
      ctx.type = 'html';
      ctx.body = errorPage(String(out.error), out.error_description ? String(out.error_description) : undefined);
    },
  };
  const provider = new Provider(config.OAUTH_ISSUER, configuration);
  if (config.TRUST_PROXY) provider.proxy = true;
  return provider;
}
