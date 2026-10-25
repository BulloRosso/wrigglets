import { describe, expect, it } from 'vitest';
import { assertPublicUrl, htmlToText } from './web.js';

describe('web access guard (no SSRF)', () => {
  it('refuses private, loopback, link-local and internal hosts', async () => {
    for (const u of ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.18.0.5:8080/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost:4000/', 'http://litellm.internal/']) {
      await expect(assertPublicUrl(u)).rejects.toThrow();
    }
  });
  it('refuses other schemes and credentials', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(assertPublicUrl('ftp://example.com/')).rejects.toThrow(/http/);
    await expect(assertPublicUrl('https://user:pw@93.184.215.14/')).rejects.toThrow(/credentials/);
  });
  it('accepts public addresses', async () => {
    await expect(assertPublicUrl('https://93.184.215.14/')).resolves.toBeInstanceOf(URL);
  });
});

describe('HTML to text', () => {
  it('keeps headings, list items and links, drops scripts', () => {
    const { title, text } = htmlToText(
      '<html><head><title>NVIDIA &amp; Co</title><script>evil()</script></head><body><h1>Kurs</h1><p>Aktuell <b>120,50&nbsp;€</b></p><ul><li>Eins</li><li><a href="/x">Mehr</a></li></ul></body></html>',
      new URL('https://example.com/a/'),
    );
    expect(title).toBe('NVIDIA & Co');
    expect(text).toContain('# Kurs');
    expect(text).toContain('120,50 €');
    expect(text).toContain('- Eins');
    expect(text).toContain('[Mehr](https://example.com/x)');
    expect(text).not.toContain('evil');
  });
});
