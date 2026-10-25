import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/*
 * Internet access for agents (ADR-0031), offered as MCP tools behind the MCP gateway: allow-list, kill switch, rate
 * limits and audit apply as for every other tool. Only public http(s) addresses are reachable — private, loopback,
 * link-local and metadata addresses are refused (no access to the Docker network or the host through this tool).
 */

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv6');

export class WebError extends Error {}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new WebError('URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new WebError('Internal host names are not allowed');
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new WebError(`Host not found: ${host}`);
  for (const a of addrs) {
    if (BLOCKED.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')) throw new WebError(`Address ${a.address} of ${host} is not public — access refused`);
  }
  return url;
}

const UA = 'CoworkingAgents-Web/1.0 (+https://github.com/BulloRosso/wrigglets)';
const MAX_BYTES = 3 * 1024 * 1024;

/** GET with manual redirects (each hop is checked again), size and time limits. */
async function get(raw: string, accept: string): Promise<{ url: URL; status: number; contentType: string; body: Buffer }> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, accept, 'accept-language': 'de,en;q=0.8' }, signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
    }
    return { url, status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks) };
  }
  throw new WebError('Too many redirects');
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));

/** Readable text of an HTML page: headings, paragraphs, lists, tables (roughly), links as [text](url). */
export function htmlToText(html: string, base: URL): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  let h = html
    .replace(/<(script|style|noscript|svg|iframe|template|head|nav|footer|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(h)?.[2];
  if (main && main.length > 500) h = main;
  h = h
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l: string, t: string) => `\n\n${'#'.repeat(Number(l))} ${t}\n\n`)
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
      const text = t.replace(/<[^>]+>/g, '').trim();
      if (!text) return '';
      try {
        return `[${text}](${new URL(decode(href), base).toString()})`;
      } catch {
        return text;
      }
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(h)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, a) => l || (a[i - 1] ?? '') !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

export async function fetchUrl(raw: string, maxChars = 20_000): Promise<string> {
  const r = await get(raw, 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5');
  const ct = r.contentType.toLowerCase();
  let title = '';
  let text: string;
  if (ct.includes('html')) ({ title, text } = htmlToText(r.body.toString('utf8'), r.url));
  else if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct.includes('markdown')) text = r.body.toString('utf8');
  else throw new WebError(`Content type ${ct || 'unknown'} cannot be read as text (${r.body.length} bytes)`);
  const limit = Math.max(1_000, Math.min(maxChars, 60_000));
  const cut = text.length > limit;
  return [`URL: ${r.url}`, `Status: ${r.status}`, title && `Title: ${title}`, '', cut ? `${text.slice(0, limit)}\n\n[… truncated, ${text.length} characters in total]` : text]
    .filter((x) => x !== '')
    .join('\n');
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Web search via DuckDuckGo's HTML endpoint (no API key; best effort). */
export async function search(query: string, max = 8): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 300);
  if (!q) throw new WebError('Empty query');
  const r = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=de-de`, 'text/html');
  if (r.status !== 200) throw new WebError(`Search returned ${r.status}`);
  const html = r.body.toString('utf8');
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [...html.matchAll(re)];
  for (const [i, m] of links.entries()) {
    // the snippet belongs to this result: look between this link and the next one
    const section = html.slice(m.index! + m[0].length, links[i + 1]?.index ?? html.length);
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(section)?.[1];
    let href = decode(m[1]!);
    const uddg = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    if (uddg) href = decodeURIComponent(uddg);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // skip ads
    const strip = (s?: string) => decode((s ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    hits.push({ title: strip(m[2]), url: href, snippet: strip(snippet) });
    if (hits.length >= Math.min(Math.max(max, 1), 15)) break;
  }
  return hits;
}
