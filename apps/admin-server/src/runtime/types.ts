import type { AgentRuntimeInfo, AgentSpec, AgentStats, ImageInfo } from '@cw/shared';

/**
 * Where agent instances run. Local: Docker Desktop (DockerRuntime). Azure: one App Service
 * (Linux, B2, Always On) per agent pulling from a private ACR (AzureAppServiceRuntime, ADR-0003).
 */
export interface AgentRuntime {
  readonly kind: string;
  ping(): Promise<{ ok: boolean; detail?: string }>;
  /** Creates (or re-creates) the instance with the given environment and starts it if requested. */
  deploy(spec: AgentSpec, env: Record<string, string>, opts: { start: boolean }): Promise<AgentRuntimeInfo>;
  start(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  restart(agentId: string): Promise<void>;
  /** Removes the instance; `purgeData` also deletes the persistent /home storage. */
  remove(agentId: string, opts: { purgeData: boolean }): Promise<void>;
  inspect(agentId: string): Promise<AgentRuntimeInfo>;
  stats(agentId: string): Promise<AgentStats | undefined>;
  /** Streams log lines; returns a function that stops the stream. */
  logs(agentId: string, opts: { tail: number; follow: boolean }, onLine: (line: string, stream: 'stdout' | 'stderr') => void, onEnd: () => void): Promise<() => void>;
  images(): Promise<ImageInfo[]>;
  /** Internal URL under which the control plane reaches the agent (health checks). */
  internalUrl(agentId: string): string;
  usedPorts(): Promise<number[]>;
}
