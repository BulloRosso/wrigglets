import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AVATAR_MOODS, type AvatarJob, type AvatarMeta, type AvatarMood, type AvatarStatus } from '@cw/shared';
import { logger } from './logger.js';

/*
 * Agent portraits (ADR-0025). The admin specifies a prompt per agent; images are generated with
 * the OpenAI Images API ("edits" with a guiding image):
 *   1. neutral  = reference image + base style + agent prompt
 *   2. happy, fearful, doubt = the agent's neutral portrait + mood instruction
 * so that the character stays the same across moods. PNG with transparent background.
 */

const MOOD_PROMPT: Record<AvatarMood, string> = {
  neutral: 'Expression: calm, friendly, attentive, mouth gently closed in a small smile.',
  happy: 'Change only the facial expression: very happy and satisfied, big open smile, bright eyes. Keep everything else identical.',
  fearful: 'Change only the facial expression: fearful and worried, wide eyes, raised eyebrows, small trembling mouth, a drop of sweat. Keep everything else identical.',
  doubt: 'Change only the facial expression: in doubt, sceptical and pondering, one eyebrow raised, mouth slanted to one side, eyes looking sideways. Keep everything else identical.',
};

/** Framing rules repeated in every request: the portraits are shown as small round avatars, so nothing may be cut off. */
const FRAMING =
  'Framing: the complete character must fit inside the image — the top of the head and the full length of both antennae (including their ' +
  'round tips) must be clearly visible with empty transparent space above them; nothing may touch or be cut by any edge of the image. ' +
  'Leave a margin of about 12% of the image size on every side, with slightly more space above the antennae than below the shoulders. ' +
  'Center the character horizontally; the head occupies roughly the middle 60% of the image height.';

const BASE_PROMPT =
  'Use the attached image as the character and style reference. Create a head-and-shoulders portrait of a mascot character in exactly this ' +
  'rendering style (glossy cartoon, thick dark outline, soft highlights), facing the viewer, no text, no frame, transparent background. ' +
  FRAMING;

export interface AvatarOptions {
  dataDir: string;
  defaultReference: string;
  apiKey?: string;
  model: string;
  quality: 'low' | 'medium' | 'high';
}

export class AvatarService {
  private readonly dir: string;
  private readonly jobs = new Map<string, AvatarJob>();

  constructor(private readonly o: AvatarOptions) {
    this.dir = path.join(o.dataDir, 'avatars');
  }

  get enabled() {
    return !!this.o.apiKey;
  }

  /* -------------------------------------------------------------- reference image */

  private customReference() {
    return path.join(this.dir, 'reference.png');
  }

  referencePath(): string | undefined {
    if (existsSync(this.customReference())) return this.customReference();
    return existsSync(this.o.defaultReference) ? this.o.defaultReference : undefined;
  }

  isCustomReference() {
    return existsSync(this.customReference());
  }

  async setReference(png: Buffer) {
    if (!isPng(png)) throw Object.assign(new Error('The reference image must be a PNG file'), { statusCode: 400 });
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.customReference(), png);
  }

  async resetReference() {
    await rm(this.customReference(), { force: true });
  }

  /* -------------------------------------------------------------- per agent */

  private agentDir(agentId: string) {
    return path.join(this.dir, agentId);
  }

  imagePath(agentId: string, mood: AvatarMood) {
    return path.join(this.agentDir(agentId), `${mood}.png`);
  }

  async meta(agentId: string): Promise<AvatarMeta | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.agentDir(agentId), 'meta.json'), 'utf8')) as AvatarMeta;
    } catch {
      return undefined;
    }
  }

  async status(agentId: string): Promise<AvatarStatus> {
    return { enabled: this.enabled, model: this.o.model, meta: await this.meta(agentId), job: this.jobs.get(agentId) };
  }

  async remove(agentId: string) {
    await rm(this.agentDir(agentId), { recursive: true, force: true });
  }

  /** Starts generation in the background; progress via `status()`. */
  start(agentId: string, prompt: string, by: string, moods: readonly AvatarMood[] = AVATAR_MOODS): AvatarJob {
    if (!this.enabled) throw Object.assign(new Error('OPENAI_API_KEY is not configured for the control plane'), { statusCode: 409 });
    const running = this.jobs.get(agentId);
    if (running?.state === 'running') throw Object.assign(new Error('A generation is already running for this agent'), { statusCode: 409 });
    const job: AvatarJob = { state: 'running', startedAt: new Date().toISOString(), moods: Object.fromEntries(moods.map((m) => [m, 'pending'])) };
    this.jobs.set(agentId, job);
    void this.run(agentId, prompt, by, moods, job);
    return job;
  }

  private async run(agentId: string, prompt: string, by: string, moods: readonly AvatarMood[], job: AvatarJob) {
    const dir = this.agentDir(agentId);
    await mkdir(dir, { recursive: true });
    const meta: AvatarMeta = (await this.meta(agentId)) ?? { prompt, model: this.o.model, by, generatedAt: '', moods: {} };
    try {
      // 1. neutral first (from the reference) — the base for all other moods
      const needsNeutral = moods.includes('neutral') || !existsSync(this.imagePath(agentId, 'neutral'));
      if (needsNeutral) {
        job.moods.neutral = 'running';
        const ref = this.referencePath();
        if (!ref) throw new Error('No reference image available');
        const img = await this.edit(await readFile(ref), `${BASE_PROMPT}\nCharacter description: ${prompt}\n${MOOD_PROMPT.neutral}`);
        await atomicWrite(this.imagePath(agentId, 'neutral'), img);
        meta.moods.neutral = { generatedAt: new Date().toISOString() };
        job.moods.neutral = 'done';
      }
      // 2. other moods in parallel, derived from the neutral portrait
      const neutral = await readFile(this.imagePath(agentId, 'neutral'));
      await Promise.all(
        moods
          .filter((m) => m !== 'neutral')
          .map(async (m) => {
            job.moods[m] = 'running';
            try {
              const img = await this.edit(neutral, `Same character, same style, same size and position in the image, transparent background. ${FRAMING} ${MOOD_PROMPT[m]}`);
              await atomicWrite(this.imagePath(agentId, m), img);
              meta.moods[m] = { generatedAt: new Date().toISOString() };
              job.moods[m] = 'done';
            } catch (err) {
              job.moods[m] = 'failed';
              throw err;
            }
          }),
      );
      job.state = 'done';
    } catch (err) {
      job.state = 'failed';
      job.error = (err as Error).message.slice(0, 500);
      for (const m of moods) if (job.moods[m] === 'pending' || job.moods[m] === 'running') job.moods[m] = 'failed';
      logger.warn({ agentId, err: job.error }, 'portrait generation failed');
    } finally {
      Object.assign(meta, { prompt, model: this.o.model, by, generatedAt: new Date().toISOString() });
      await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    }
  }

  /** OpenAI Images API, edit endpoint (multipart). */
  private async edit(image: Buffer, prompt: string): Promise<Buffer> {
    const form = new FormData();
    form.append('model', this.o.model);
    form.append('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'reference.png');
    form.append('prompt', prompt);
    form.append('size', '1024x1024');
    form.append('quality', this.o.quality);
    form.append('background', 'transparent');
    form.append('output_format', 'png');
    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await res.json()) as { data?: Array<{ b64_json?: string }>; error?: { message?: string } };
    if (!res.ok || !body.data?.[0]?.b64_json) throw new Error(`Image generation failed (${res.status}): ${body.error?.message ?? 'no image returned'}`);
    return Buffer.from(body.data[0].b64_json, 'base64');
  }
}

const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

async function atomicWrite(file: string, data: Buffer) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
