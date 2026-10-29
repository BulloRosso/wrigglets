// Screenshots of the real UIs with headless Chromium (playwright-core; run `npm install` in this folder once).
// The browser comes from PLAYWRIGHT_CHROMIUM, or from the Playwright cache of this machine.
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { HOST, MOCK, PASSWORD, sleep } from './lib.mjs';

function chromePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const caches = [path.join(os.homedir(), 'AppData/Local/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'), path.join(os.homedir(), 'Library/Caches/ms-playwright')];
  for (const c of caches.filter(existsSync)) {
    for (const d of readdirSync(c).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(c, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chromium found: set PLAYWRIGHT_CHROMIUM to a chrome executable');
}

export class Shots {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  async open() {
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    this.contexts = new Map(); // email -> context (signed in)
    return this;
  }

  /** A page signed in as `email` (OIDC sign-in through the real sign-in form; the SSO cookie covers all UIs). */
  async page(email, startUrl, { width = 1280, height = 800 } = {}) {
    if (startUrl.startsWith(MOCK)) email = 'anonymous'; // the mock status page has no sign-in
    let ctx = this.contexts.get(email);
    if (!ctx) {
      ctx = await this.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      this.contexts.set(email, ctx);
      if (email === 'anonymous') return this.page(email, startUrl, { width, height });
      const p = await ctx.newPage();
      await p.goto(startUrl);
      await p.getByLabel('E-mail').fill(email);
      await p.locator('input[type=password]').fill(email === process.env.ADMIN_EMAIL ? process.env.ADMIN_PASSWORD : PASSWORD);
      await p.getByRole('button', { name: /sign in/i }).click();
      await p.waitForURL((u) => new URL(u).port === new URL(startUrl).port, { timeout: 30_000 });
      await p.close();
    }
    const page = await ctx.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(startUrl, { waitUntil: 'load' }).catch(() => undefined);
    return page;
  }

  async snap(email, url, name, { width, height, fullPage = false, wait = 1200, before } = {}) {
    const page = await this.page(email, url, { width, height });
    await sleep(wait);
    if (before) await before(page);
    const file = path.join(this.dir, `${name}.png`);
    await page.screenshot({ path: file, fullPage });
    await page.close();
    return file;
  }

  async close() {
    await this.browser?.close();
  }
}

export const dashboardUrl = `${MOCK}/dashboard?blur=customers`;
export { HOST };
