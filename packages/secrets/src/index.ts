import { ManagedIdentityCredential, DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

/*
 * Secrets in Azure Key Vault via the official SDK (ADR-0024).
 *
 * Local: Lowkey Vault (`https://keyvault:8443`) with its simulated managed-identity token endpoint
 * (`AZURE_POD_IDENTITY_AUTHORITY_HOST=http://keyvault:8080`) and a locally generated CA
 * (`NODE_EXTRA_CA_CERTS`). Azure: the real vault URL and the app's managed identity — same code.
 */

export interface SecretStoreOptions {
  vaultUrl: string;
  /** Set for the local emulator only: its host is not a *.vault.azure.net name. */
  emulator?: boolean;
  /** Cache lifetime for read values (default 5 min). */
  cacheTtlMs?: number;
  credential?: TokenCredential;
}

export interface SecretInfo {
  name: string;
  enabled: boolean;
  updatedOn?: string;
  contentType?: string;
  tags?: Record<string, string>;
}

export class SecretStore {
  private readonly client: SecretClient;
  private readonly cache = new Map<string, { value: string; until: number }>();
  private readonly ttl: number;

  constructor(o: SecretStoreOptions) {
    const credential = o.credential ?? (o.emulator ? new ManagedIdentityCredential() : new DefaultAzureCredential());
    this.client = new SecretClient(o.vaultUrl, credential, { disableChallengeResourceVerification: !!o.emulator });
    this.ttl = o.cacheTtlMs ?? 5 * 60_000;
  }

  static fromEnv(env = process.env): SecretStore | undefined {
    if (!env.KEYVAULT_URL) return undefined;
    return new SecretStore({ vaultUrl: env.KEYVAULT_URL, emulator: env.KEYVAULT_EMULATOR === 'true' });
  }

  /** Reads a secret (cached). Throws if it does not exist. */
  async get(name: string): Promise<string> {
    const hit = this.cache.get(name);
    if (hit && hit.until > Date.now()) return hit.value;
    const s = await this.client.getSecret(name);
    if (s.value === undefined) throw new Error(`Secret ${name} has no value`);
    this.cache.set(name, { value: s.value, until: Date.now() + this.ttl });
    return s.value;
  }

  async set(name: string, value: string, opts: { contentType?: string; tags?: Record<string, string> } = {}): Promise<void> {
    await this.client.setSecret(name, value, opts);
    this.cache.delete(name);
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.getSecret(name);
      return true;
    } catch {
      return false;
    }
  }

  /** Names and metadata only — values are never listed. */
  async list(): Promise<SecretInfo[]> {
    const out: SecretInfo[] = [];
    for await (const p of this.client.listPropertiesOfSecrets()) {
      out.push({ name: p.name, enabled: p.enabled ?? true, updatedOn: p.updatedOn?.toISOString(), contentType: p.contentType, tags: p.tags });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(name: string): Promise<void> {
    const poller = await this.client.beginDeleteSecret(name);
    await poller.pollUntilDone();
    this.cache.delete(name);
  }

  async ping(): Promise<boolean> {
    try {
      const it = this.client.listPropertiesOfSecrets().byPage({ maxPageSize: 1 });
      await it.next();
      return true;
    } catch {
      return false;
    }
  }
}

/** Key Vault secret names: 1–127 chars, alphanumerics and dashes. */
export const SECRET_NAME_PATTERN = /^[0-9a-zA-Z-]{1,127}$/;
