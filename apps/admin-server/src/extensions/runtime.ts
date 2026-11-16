import Docker from 'dockerode';
import {
  containerName,
  LABEL_EXTENSION,
  LABEL_ROLE,
  LABEL_SERVICE,
  LABEL_SPEC,
  ROLE_CONTAINER,
  ROLE_VOLUME,
  volumeName,
  type ServiceSpec,
  type ServiceState,
} from '@cw/extensions';
import { logger } from '../logger.js';

export interface ManagedContainer {
  service: string;
  fingerprint?: string;
  running: boolean;
  state: ServiceState;
  detail: string;
  image: string;
}

/** What the extension manager needs from a container runtime (Docker locally; a fake in tests). */
export interface ExtensionRuntime {
  ping(): Promise<{ ok: boolean; detail: string }>;
  imagePresent(ref: string): Promise<boolean>;
  pullImage(ref: string): Promise<void>;
  ensureVolume(ext: string, vol: string): Promise<void>;
  removeVolume(ext: string, vol: string): Promise<void>;
  /** All containers labelled as belonging to the extension. */
  list(ext: string): Promise<ManagedContainer[]>;
  /** (Re-)creates and starts the service's container. */
  run(ext: string, svc: ServiceSpec, env: Record<string, string>, fingerprint: string): Promise<void>;
  start(ext: string, service: string): Promise<void>;
  remove(ext: string, service: string): Promise<void>;
  logs(ext: string, service: string, tail: number): Promise<string>;
}

export function parseState(status: string, running: boolean): ServiceState {
  if (!running) return 'stopped';
  if (/health: starting/.test(status)) return 'starting';
  if (/unhealthy/.test(status)) return 'unhealthy';
  return 'running';
}

/**
 * Extension containers on Docker, through the socket the control plane already holds for agent containers (ADR-0003).
 * Containers and volumes carry the cw.role / cw.extension labels; compose's --remove-orphans does not touch them.
 */
export class DockerExtensionRuntime implements ExtensionRuntime {
  private readonly docker: Docker;

  constructor(
    socketPath: string,
    private readonly network: string,
  ) {
    this.docker = new Docker({ socketPath });
  }

  async ping() {
    try {
      const v = await this.docker.version();
      return { ok: true, detail: `Docker ${v.Version}` };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }

  async imagePresent(ref: string) {
    try {
      await this.docker.getImage(ref).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async pullImage(ref: string) {
    logger.info({ ref }, 'pulling extension image');
    const stream = await this.docker.pull(ref);
    await new Promise((resolve, reject) => this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve(undefined))));
  }

  async ensureVolume(ext: string, vol: string) {
    const name = volumeName(ext, vol);
    const vols = await this.docker.listVolumes({ filters: JSON.stringify({ name: [name] }) });
    if (!vols.Volumes?.some((v) => v.Name === name)) await this.docker.createVolume({ Name: name, Labels: { [LABEL_ROLE]: ROLE_VOLUME, [LABEL_EXTENSION]: ext } });
  }

  async removeVolume(ext: string, vol: string) {
    await this.docker
      .getVolume(volumeName(ext, vol))
      .remove()
      .catch((err: { statusCode?: number }) => {
        if (err.statusCode !== 404) throw err;
      });
  }

  async list(ext: string): Promise<ManagedContainer[]> {
    const list = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABEL_ROLE}=${ROLE_CONTAINER}`, `${LABEL_EXTENSION}=${ext}`] }) });
    return list.map((c) => {
      const running = c.State === 'running';
      return { service: c.Labels[LABEL_SERVICE] ?? '?', fingerprint: c.Labels[LABEL_SPEC], running, state: parseState(c.Status, running), detail: c.Status, image: c.Image };
    });
  }

  private async ensureNetwork() {
    const nets = await this.docker.listNetworks({ filters: JSON.stringify({ name: [this.network] }) });
    if (!nets.some((n) => n.Name === this.network)) await this.docker.createNetwork({ Name: this.network, Driver: 'bridge' });
  }

  async run(ext: string, svc: ServiceSpec, env: Record<string, string>, fingerprint: string) {
    await this.ensureNetwork();
    await this.remove(ext, svc.name);
    const h = svc.healthcheck;
    const container = await this.docker.createContainer({
      name: containerName(ext, svc.name),
      Image: svc.image,
      Cmd: svc.command,
      User: svc.user,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { [LABEL_ROLE]: ROLE_CONTAINER, [LABEL_EXTENSION]: ext, [LABEL_SERVICE]: svc.name, [LABEL_SPEC]: fingerprint },
      Healthcheck: h ? { Test: h.test, Interval: h.intervalSec * 1e9, Timeout: h.timeoutSec * 1e9, Retries: h.retries, StartPeriod: h.startPeriodSec * 1e9 } : undefined,
      HostConfig: {
        Mounts: svc.volumes.map((v) => ({ Type: 'volume' as const, Source: volumeName(ext, v.name), Target: v.target })),
        NetworkMode: this.network,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: svc.memoryMb ? svc.memoryMb * 1024 * 1024 : undefined,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      },
      NetworkingConfig: { EndpointsConfig: { [this.network]: { Aliases: [svc.name] } } },
    });
    await container.start();
  }

  async start(ext: string, service: string) {
    await this.docker.getContainer(containerName(ext, service)).start();
  }

  async remove(ext: string, service: string) {
    const c = this.docker.getContainer(containerName(ext, service));
    try {
      const i = await c.inspect();
      // Never touch a container that is not ours, even if the name matches.
      if (i.Config.Labels?.[LABEL_EXTENSION] !== ext) throw new Error(`container ${containerName(ext, service)} exists but is not managed by extension ${ext}`);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return;
      throw err;
    }
    await c.stop({ t: 20 }).catch(() => undefined);
    await c.remove({ force: true }).catch((err: { statusCode?: number }) => {
      if (err.statusCode !== 404) throw err;
    });
  }

  async logs(ext: string, service: string, tail: number) {
    const c = this.docker.getContainer(containerName(ext, service));
    const buf = (await c.logs({ follow: false, stdout: true, stderr: true, tail, timestamps: true })) as unknown as Buffer;
    // Demultiplex the 8-byte frame headers of non-TTY logs.
    const out: string[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i + 4);
      out.push(buf.subarray(i + 8, i + 8 + len).toString('utf8'));
      i += 8 + len;
    }
    return out.join('') || buf.toString('utf8');
  }
}
