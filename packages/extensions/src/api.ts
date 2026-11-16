import { z } from 'zod';

/* Types of the admin API for extensions (shared by admin-server and admin-web). */

export type ExtensionPhase = 'not_installed' | 'installing' | 'installed' | 'failed' | 'uninstalling';
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ExtensionStep {
  id: string;
  label: string;
  state: StepState;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface ExtensionOperation {
  kind: 'install' | 'uninstall' | 'repair';
  by: string;
  startedAt: string;
  finishedAt?: string;
  options: Record<string, boolean>;
  steps: ExtensionStep[];
}

export type ServiceState = 'running' | 'starting' | 'unhealthy' | 'stopped' | 'missing';

export interface ExtensionServiceStatus {
  name: string;
  description?: string;
  image: string;
  local: boolean;
  state: ServiceState;
  detail: string;
  imagePresent?: boolean;
}

export interface ExtensionStatus {
  id: string;
  name: string;
  description: string;
  version: string;
  docs?: string;
  /** "console" = installed and managed from the admin console; "overlay" = started with a compose overlay. */
  mode: 'console' | 'overlay';
  phase: ExtensionPhase;
  /** Installed and every service running (or overlay present): the extension's features are on. */
  available: boolean;
  installedAt?: string;
  installedBy?: string;
  installedVersion?: string;
  operation?: ExtensionOperation;
  services: ExtensionServiceStatus[];
  upstreams: string[];
  uiRoutes: Array<{ label: string; path: string }>;
  /** Images that must be built first (`node scripts/stack.mjs build --liquid`). */
  missingImages: string[];
  /** Why install is not possible right now, if it is not. */
  blockedReason?: string;
}

export const installBody = z.object({ seedDemo: z.boolean().default(false) }).strict();
export const uninstallBody = z.object({ purgeData: z.boolean().default(false) }).strict();
