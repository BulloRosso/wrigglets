import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import type { AgentRuntimeInfo, AgentSpec, AgentStats, ImageInfo, RuntimeState } from '@cw/shared';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import type { AgentRuntime } from './types.js';

const containerName = (agentId: string) => `cw-agent-${agentId}`;
const volumeName = (agentId: string) => `cw-agent-${agentId}-home`;
const LABEL_ROLE = 'cw.role';
const LABEL_AGENT = 'cw.agentId';

/**
 * Agent containers on Docker Desktop, managed through the Docker socket mounted into the
 * temporal/admin container. Each agent gets one container, one named volume mounted at /home
 * (the persistent workspace, like App Service /home on Azure) and a host port for its UI.
 */
export class DockerRuntime implements AgentRuntime {
  readonly kind = 'docker';
  private readonly docker: Docker;

  constructor(private readonly config: Config) {
    this.docker = new Docker({ socketPath: config.DOCKER_SOCKET });
  }

  async ping() {
    try {
      const v = await this.docker.version();
      return { ok: true, detail: `Docker ${v.Version} (${v.Os}/${v.Arch})` };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }

  private container(agentId: string) {
    return this.docker.getContainer(containerName(agentId));
  }

  async deploy(spec: AgentSpec, env: Record<string, string>, opts: { start: boolean }): Promise<AgentRuntimeInfo> {
    await this.ensureNetwork();
    await this.ensureImage(spec.image);
    const vols = await this.docker.listVolumes({ filters: JSON.stringify({ name: [volumeName(spec.agentId)] }) });
    if (!vols.Volumes?.some((v) => v.Name === volumeName(spec.agentId))) {
      await this.docker.createVolume({ Name: volumeName(spec.agentId), Labels: { [LABEL_ROLE]: 'agent-home', [LABEL_AGENT]: spec.agentId } });
    }
    // Re-create: the volume (workspace) survives, the container is disposable.
    try {
      const old = this.container(spec.agentId);
      await old.stop({ t: 25 }).catch(() => undefined);
      await old.remove({ force: true });
    } catch {
      /* did not exist */
    }
    const container = await this.docker.createContainer({
      name: containerName(spec.agentId),
      Image: spec.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { [LABEL_ROLE]: 'agent', [LABEL_AGENT]: spec.agentId, 'cw.displayName': spec.displayName },
      ExposedPorts: { '8080/tcp': {} },
      Healthcheck: {
        Test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
        Interval: 30e9,
        Timeout: 5e9,
        Retries: 3,
        StartPeriod: 180e9,
      },
      HostConfig: {
        PortBindings: { '8080/tcp': [{ HostIp: this.config.AGENT_BIND_IP, HostPort: String(spec.hostPort) }] },
        Mounts: [{ Type: 'volume', Source: volumeName(spec.agentId), Target: '/home' }],
        NetworkMode: this.config.DOCKER_NETWORK,
        RestartPolicy: { Name: 'unless-stopped' },
        NanoCpus: Math.round(spec.resources.cpus * 1e9),
        Memory: spec.resources.memoryMb * 1024 * 1024,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      },
      NetworkingConfig: { EndpointsConfig: { [this.config.DOCKER_NETWORK]: { Aliases: [`agent-${spec.agentId}`] } } },
    });
    if (opts.start) await container.start();
    return this.inspect(spec.agentId);
  }

  private async ensureNetwork() {
    const nets = await this.docker.listNetworks({ filters: JSON.stringify({ name: [this.config.DOCKER_NETWORK] }) });
    if (!nets.some((n) => n.Name === this.config.DOCKER_NETWORK)) {
      await this.docker.createNetwork({ Name: this.config.DOCKER_NETWORK, Driver: 'bridge' });
    }
  }

  private async ensureImage(ref: string) {
    try {
      await this.docker.getImage(ref).inspect();
    } catch {
      // Not local: try to pull (e.g. from a registry). Locally built images never need this.
      logger.info({ ref }, 'pulling agent image');
      const stream = await this.docker.pull(ref);
      await new Promise((resolve, reject) => this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve(undefined))));
    }
  }

  async start(agentId: string) {
    await this.container(agentId).start();
  }

  async stop(agentId: string) {
    await this.container(agentId).stop({ t: 25 });
  }

  async restart(agentId: string) {
    await this.container(agentId).restart({ t: 25 });
  }

  async remove(agentId: string, opts: { purgeData: boolean }) {
    try {
      await this.container(agentId).remove({ force: true });
    } catch {
      /* already gone */
    }
    if (opts.purgeData) await this.docker.getVolume(volumeName(agentId)).remove().catch(() => undefined);
  }

  async inspect(agentId: string): Promise<AgentRuntimeInfo> {
    try {
      const i = await this.container(agentId).inspect();
      const s = i.State;
      let state: RuntimeState = 'stopped';
      if (s.Restarting) state = 'restarting';
      else if (s.Running) state = s.Health?.Status === 'starting' ? 'starting' : s.Health?.Status === 'unhealthy' ? 'failed' : 'running';
      else if (s.ExitCode !== 0 && s.Status === 'exited') state = 'failed';
      return {
        state,
        detail: `${s.Status}${s.Health ? ` · health: ${s.Health.Status}` : ''}${!s.Running && s.ExitCode ? ` · exit ${s.ExitCode}` : ''}`,
        containerId: i.Id.slice(0, 12),
        image: i.Config.Image,
        startedAt: s.StartedAt && !s.StartedAt.startsWith('0001') ? s.StartedAt : undefined,
        finishedAt: s.FinishedAt && !s.FinishedAt.startsWith('0001') ? s.FinishedAt : undefined,
        exitCode: s.ExitCode,
        restartCount: i.RestartCount,
      };
    } catch {
      return { state: 'missing', detail: 'container does not exist' };
    }
  }

  async stats(agentId: string): Promise<AgentStats | undefined> {
    try {
      const s = (await this.container(agentId).stats({ stream: false })) as unknown as Docker.ContainerStats;
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
      const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
      const cache = (s.memory_stats.stats as Record<string, number> | undefined)?.inactive_file ?? 0;
      const nets = Object.values(s.networks ?? {});
      return {
        at: new Date().toISOString(),
        cpuPercent: sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0,
        memoryBytes: Math.max(0, (s.memory_stats.usage ?? 0) - cache),
        memoryLimitBytes: s.memory_stats.limit ?? 0,
        netRxBytes: nets.reduce((a, n) => a + n.rx_bytes, 0),
        netTxBytes: nets.reduce((a, n) => a + n.tx_bytes, 0),
      };
    } catch {
      return undefined;
    }
  }

  async logs(agentId: string, opts: { tail: number; follow: boolean }, onLine: (line: string, stream: 'stdout' | 'stderr') => void, onEnd: () => void) {
    const c = this.container(agentId);
    const info = await c.inspect();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const split = (s: PassThrough, name: 'stdout' | 'stderr') => {
      let buf = '';
      s.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l) onLine(l, name);
      });
    };
    split(stdout, 'stdout');
    split(stderr, 'stderr');
    if (opts.follow) {
      const stream = await c.logs({ follow: true, stdout: true, stderr: true, tail: opts.tail, timestamps: true });
      if (info.Config.Tty) stream.pipe(stdout);
      else c.modem.demuxStream(stream, stdout, stderr);
      stream.on('end', onEnd);
      return () => (stream as unknown as { destroy(): void }).destroy();
    }
    const buf = (await c.logs({ follow: false, stdout: true, stderr: true, tail: opts.tail, timestamps: true })) as unknown as Buffer;
    const s = new PassThrough();
    c.modem.demuxStream(s, stdout, stderr);
    s.end(buf);
    s.on('end', () => setImmediate(onEnd));
    return () => undefined;
  }

  async images(): Promise<ImageInfo[]> {
    const list = await this.docker.listImages({ filters: JSON.stringify({ reference: [`${this.config.AGENT_IMAGE_REPOSITORY}`] }) });
    return list
      .flatMap((i) =>
        (i.RepoTags ?? []).map((reference) => ({ reference, id: i.Id.replace('sha256:', '').slice(0, 12), created: new Date(i.Created * 1000).toISOString(), sizeBytes: i.Size, labels: i.Labels ?? {} })),
      )
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  internalUrl(agentId: string) {
    return `http://agent-${agentId}:8080`;
  }

  async usedPorts(): Promise<number[]> {
    const list = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABEL_ROLE}=agent`] }) });
    return list.flatMap((c) => c.Ports.map((p) => p.PublicPort).filter((p): p is number => !!p));
  }
}
