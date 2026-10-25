/*
 * Server-rendered pages that oidc-provider needs outside the interaction SPA (logout, errors).
 * Styled like the Material UI theme in packages/ui (same colours, Roboto, elevated card).
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function page(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f6fa; --paper:#fff; --text:#1b2330; --muted:#5b6777; --primary:#1f5fad; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f141b; --paper:#18202b; --text:#e6ebf2; --muted:#9aa7b7; --primary:#7fb2ff; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font-family: Roboto, "Segoe UI", system-ui, -apple-system, sans-serif; padding:16px; }
  .card { background:var(--paper); width:100%; max-width:420px; border-radius:12px; padding:32px;
          box-shadow:0 2px 1px -1px rgba(0,0,0,.2),0 1px 1px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.12); }
  .brand { display:flex; align-items:center; gap:10px; color:var(--primary); font-weight:500; letter-spacing:.02em; margin-bottom:24px; }
  .brand svg { width:28px; height:28px; }
  h1 { font-size:1.5rem; font-weight:400; margin:0 0 8px; }
  p { color:var(--muted); line-height:1.5; margin:0 0 16px; }
  button { appearance:none; border:0; border-radius:8px; background:var(--primary); color:#fff; font:500 .9rem/1 inherit;
           letter-spacing:.04em; text-transform:uppercase; padding:12px 20px; cursor:pointer; width:100%; }
</style></head>
<body><main class="card">
<div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.8 3.8L12 11.9 5.2 8.1 12 4.3ZM5 9.8l6 3.4v6.6l-6-3.4V9.8Zm8 10V13.2l6-3.4v6.6l-6 3.4Z"/></svg>Coworking Agents · Sign-in</div>
${body}
</main>${script}</body></html>`;
}

export const logoutPage = (form: string) =>
  page(
    'Signing out…',
    `<h1>Signing out…</h1><p>You are being signed out of all coworking agents.</p>${form}<button form="op.logoutForm" type="submit" name="logout" value="yes">Sign out</button>`,
    `<script>document.addEventListener('DOMContentLoaded',function(){var f=document.getElementById('op.logoutForm');var i=document.createElement('input');i.type='hidden';i.name='logout';i.value='yes';f.appendChild(i);f.submit();});</script>`,
  );

export const signedOutPage = (client?: string) =>
  page('Signed out', `<h1>You are signed out</h1><p>${client ? `You have been signed out of ${esc(client)}.` : 'You have been signed out.'} You can close this window.</p>`);

export const errorPage = (error: string, description?: string) =>
  page('Sign-in error', `<h1>Something went wrong</h1><p><strong>${esc(error)}</strong></p>${description ? `<p>${esc(description)}</p>` : ''}`);
