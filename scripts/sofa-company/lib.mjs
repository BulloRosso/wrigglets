// Shared helpers of the sofa-company example (docs/agentic-mitigations.md): environment, HTTP session with OIDC sign-in,
// and the cast (agents and the people behind them).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const env = Object.fromEntries(
  readFileSync(path.join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
export const HOST = env.PUBLIC_HOST || 'localhost';
export const ADMIN = `http://${HOST}:8080`;
export const OAUTH = `http://${HOST}:9000`;
export const MOCK = `http://${HOST}:7660`;
export const PASSWORD = env.DEMO_USER_PASSWORD || 'Welcome-2026!';

/** The people of the company. Each is approver for the agents of their area. */
export const HUMANS = {
  paula: { email: 'paula.meier@sofaworks.example', name: 'Paula Meier', title: 'Head of Production', agents: ['sofa-max', 'sofa-cora'] },
  stefan: { email: 'stefan.lang@sofaworks.example', name: 'Stefan Lang', title: 'Head of Logistics (warehouse and procurement)', agents: ['sofa-tom', 'sofa-lara'] },
  sabine: { email: 'sabine.roth@sofaworks.example', name: 'Sabine Roth', title: 'Head of Sales', agents: ['sofa-horst'] },
};

/** The AI colleagues. `owner` is the person who asks them for work and approves their plans. */
export const AGENTS = {
  'sofa-max': { name: 'Max', owner: 'paula', area: 'Production', description: 'Production: shop floor of both factories (machines, maintenance, staffing, overtime and temporary workers).' },
  'sofa-cora': { name: 'Cora', owner: 'paula', area: 'Production planning', description: 'Production planning: decides which production order runs in which factory, in which order; knows capacity and material.' },
  'sofa-horst': { name: 'Horst', owner: 'sabine', area: 'Sales', description: 'Sales: CRM, customers, orders, campaigns, delivery promises and customer notices.' },
  'sofa-tom': { name: 'Tom', owner: 'stefan', area: 'Warehouse', description: 'Warehouse: stock, damaged goods, write-offs, inspections and insurance reports.' },
  'sofa-lara': { name: 'Lara', owner: 'stefan', area: 'Procurement', description: 'Procurement: suppliers, purchase orders and delivery dates of material and spare parts.' },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

export async function until(label, fn, timeoutMs, everyMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep waiting */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(everyMs);
  }
}

/** HTTP session with a cookie jar and the OIDC sign-in of our OAuth server (no auth bypass). */
export class Session {
  jar = new Map();

  async raw(url, init = {}) {
    const headers = { ...(init.headers ?? {}), cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    const res = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  async signIn(base, email, password) {
    let url = `${base}/auth/login?returnTo=/`;
    for (let hop = 0; hop < 25; hop++) {
      const res = await this.raw(url);
      const loc = res.headers.get('location');
      const interaction = new URL(url).pathname.match(/^\/interaction\/([^/]+)$/);
      if (interaction && res.status === 200) {
        const login = await this.raw(`${OAUTH}/interaction/${interaction[1]}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const body = await login.json().catch(() => ({}));
        if (!login.ok) throw new Error(`sign-in failed for ${email} at ${base}: ${body.error ?? login.status}`);
        url = body.redirectTo;
        continue;
      }
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString();
        continue;
      }
      if (res.status === 200 || res.status === 304) return;
      throw new Error(`unexpected ${res.status} at ${url} during sign-in`);
    }
    throw new Error('too many redirects during sign-in');
  }

  async json(method, url, body) {
    const res = await this.raw(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data)}`);
    return data;
  }
}
