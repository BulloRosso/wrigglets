import type { Client } from '@temporalio/client';
import type { PayloadCodec } from '@temporalio/common';
import type { Config } from '../config.js';
import type { HarnessClient } from '../harness/client.js';
import type { HarnessEventBus } from '../harness/events.js';
import type { HarnessSupervisor } from '../harness/supervisor.js';
import type { GatewayClient } from '../gatewayClient.js';
import type { GuardService } from '../guard/service.js';
import type { NotificationStore } from '../notifications.js';
import type { SpendClient } from '../spend.js';
import type { Git } from '../workspace/git.js';

/** Everything activities depend on, injected at worker creation (keeps activities testable). */
export interface ActivityDeps {
  config: Config;
  git: Git;
  harness: HarnessClient;
  supervisor: Pick<HarnessSupervisor, 'waitUntilHealthy'>;
  events: HarnessEventBus;
  temporal: () => Client;
  codec: PayloadCodec;
  notifications: NotificationStore;
  gateway: GatewayClient;
  spend: Pick<SpendClient, 'get'>;
  /** Exfiltration guard (ADR-0033); absent when the harness is disabled. */
  guard?: Pick<GuardService, 'haltOf' | 'clearHalt' | 'evaluationsOf' | 'getConfig'>;
}
