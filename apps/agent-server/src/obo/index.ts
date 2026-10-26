import type { Config } from '../config.js';
import { EntraClient } from './entraClient.js';
import { OboService } from './oboService.js';
import { UserTokenStore } from './userTokenStore.js';

export { OboService } from './oboService.js';
export { mountObo } from './route.js';

export interface Obo {
  service: OboService;
  client: EntraClient;
  /** Scope of the agent's own API; the sign-in requests it so the access token can be exchanged (OBO). */
  userScope: string;
}

/** The optional Entra OBO capability; undefined unless the control plane enabled it for this agent. */
export function createObo(config: Config): Obo | undefined {
  if (!config.ENTRA_ENABLED) return undefined;
  const kind = config.ENTRA_CREDENTIAL_KIND!;
  const client = new EntraClient({
    authorityHost: config.ENTRA_AUTHORITY_HOST,
    tenantId: config.ENTRA_TENANT_ID!,
    clientId: config.ENTRA_CLIENT_ID!,
    credential:
      kind === 'secret'
        ? { kind, secret: config.ENTRA_CLIENT_SECRET! }
        : kind === 'cert'
          ? { kind, pem: config.ENTRA_CLIENT_CERT_PEM! }
          : { kind, tokenFile: config.ENTRA_FEDERATED_TOKEN_FILE! },
  });
  const userScope = `api://${config.ENTRA_CLIENT_ID}/access_as_user`;
  const store = new UserTokenStore(config.oboDir, config.SESSION_SECRET ?? config.ENTRA_CLIENT_ID!);
  return { client, userScope, service: new OboService(client, store, { userScope, allowAgentOnly: config.ENTRA_ALLOW_AGENT_ONLY }) };
}
