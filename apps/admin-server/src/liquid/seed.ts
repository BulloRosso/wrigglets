import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** All files under dir as { <prefix><relative path>: text } (seed of the config repository). */
export async function readTree(dir: string, prefix: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || e.name === '__pycache__') continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else if (/\.(ya?ml|rego|json|md)$/.test(e.name)) out[`${prefix}${r}`] = (await readFile(p, 'utf8')).replace(/\r\n/g, '\n');
    }
  };
  await walk(dir, '');
  return out;
}
