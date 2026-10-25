import type { AgentRuntimeInfo, AgentStats, ImageInfo } from '@cw/shared';
import type { AgentRuntime } from './types.js';

/**
 * Placeholder for the Azure runtime (not used locally). See docs/azure.md and ADR-0003.
 *
 * Intended implementation (Azure SDK for JS, managed identity of the control plane):
 *  - deploy:  @azure/arm-appservice → WebApps.beginCreateOrUpdate on the shared Linux plan
 *             (B2, Always On, VNet integration, `linuxFxVersion: DOCKER|<acr>.azurecr.io/coworking/agent:<tag>`,
 *             `acrUseManagedIdentityCreds: true`, WEBSITES_ENABLE_APP_SERVICE_STORAGE=true),
 *             app settings = env (secrets as Key Vault references), EasyAuth (authsettingsV2) or OIDC.
 *  - start/stop/restart: WebApps.start / stop / restart
 *  - remove:  WebApps.delete (+ optional backup of /home first)
 *  - inspect: WebApps.get → state, plus /health of the app
 *  - stats:   @azure/monitor-query → CpuPercentage / MemoryWorkingSet metrics
 *  - logs:    Log Analytics (AppServiceConsoleLogs) or the Kudu log stream
 *  - images:  @azure/container-registry → ContainerRegistryClient.listManifestProperties
 */
export class AzureAppServiceRuntime implements AgentRuntime {
  readonly kind = 'azure-app-service';
  private fail(): never {
    throw new Error('The Azure App Service runtime is not implemented in the local build (see docs/azure.md).');
  }
  async ping() {
    return { ok: false, detail: 'not implemented locally' };
  }
  deploy(): Promise<AgentRuntimeInfo> {
    return this.fail();
  }
  start(): Promise<void> {
    return this.fail();
  }
  stop(): Promise<void> {
    return this.fail();
  }
  restart(): Promise<void> {
    return this.fail();
  }
  remove(): Promise<void> {
    return this.fail();
  }
  async inspect(): Promise<AgentRuntimeInfo> {
    return { state: 'missing', detail: 'Azure runtime not implemented locally' };
  }
  async stats(): Promise<AgentStats | undefined> {
    return undefined;
  }
  logs(): Promise<() => void> {
    return this.fail();
  }
  async images(): Promise<ImageInfo[]> {
    return [];
  }
  internalUrl(agentId: string) {
    return `https://app-agent-${agentId}.azurewebsites.net`;
  }
  async usedPorts() {
    return [];
  }
}
