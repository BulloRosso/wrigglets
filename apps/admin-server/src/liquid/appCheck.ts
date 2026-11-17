/*
 * Registration check of an app for Liquid Enterprise (ADR-0050). Apps are small UIs, often generated ("vibe-coded"),
 * so the check is strict and static. It runs on the submitted files before an app can be activated:
 *
 *   layout        package.json, src/, the app SDK at src/liquid-sdk.ts, a built dist/index.html; safe paths, size
 *   dependencies  every dependency pinned to an exact version and on the allow-list; no install scripts
 *   only the SDK  src/liquid-sdk.ts is byte-identical to the SDK of the ontology in force; no other file performs
 *                 network calls, dynamic code or imports anything but relative files and the allowed packages
 *   actions       the actions and classes the app is registered for exist in the ontology in force
 *   bundle        dist/index.html loads nothing from another origin (the app host adds a CSP on top)
 *
 * Pure: files in, checks out.
 */

export interface AppCheck {
  name: string;
  ok: boolean;
  errors?: string[];
}

export interface AppCheckInput {
  files: Record<string, Buffer>;
  actions: string[];
  reads: string[];
  /** The app SDK of the ontology in force (genAppSdk). */
  sdk: string;
  ontology: { actions: string[]; classes: string[] };
}

export const APP_SDK_FILE = 'src/liquid-sdk.ts';
export const RUNTIME_DEPENDENCIES = ['react', 'react-dom'];
export const DEV_DEPENDENCIES = ['vite', '@vitejs/plugin-react', 'typescript', '@types/react', '@types/react-dom'];
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 400;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];
const CODE = /\.(m?[jt]sx?|cjs)$/;

/** Network access, dynamic code and escapes from the SDK — none of it may appear outside src/liquid-sdk.ts. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfetch\b/, 'fetch (use the SDK)'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon'],
  [/\bimportScripts\b/, 'importScripts'],
  [/\bnew\s+(Shared)?Worker\b/, 'web workers'],
  [/\beval\s*\(/, 'eval'],
  [/\bnew\s+Function\s*\(/, 'new Function'],
  [/\bdocument\.cookie\b/, 'document.cookie'],
  [/\bwindow\.open\s*\(/, 'window.open'],
  [/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i, 'an absolute URL'],
];
const IMPORT = /(?:\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?|\bexport\s+[\w*{}\s,]+\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

export function checkApp(input: AppCheckInput): AppCheck[] {
  const { files } = input;
  const paths = Object.keys(files).sort();
  const text = (p: string) => files[p]!.toString('utf8').replace(/\r\n/g, '\n');
  const checks: AppCheck[] = [];
  const push = (name: string, errors: string[]) => checks.push({ name, ok: errors.length === 0, errors: errors.length ? errors.slice(0, 20) : undefined });

  // layout
  {
    const e: string[] = [];
    const total = Object.values(files).reduce((n, b) => n + b.length, 0);
    if (total > MAX_BYTES) e.push(`the app has ${total} bytes (at most ${MAX_BYTES})`);
    if (paths.length > MAX_FILES) e.push(`the app has ${paths.length} files (at most ${MAX_FILES})`);
    for (const p of paths) if (!/^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/.test(p) || p.split('/').some((s) => s === '..' || s === '.') || p.startsWith('node_modules/')) e.push(`path not allowed: ${p}`);
    for (const need of ['package.json', APP_SDK_FILE, 'dist/index.html']) if (!files[need]) e.push(`missing ${need}`);
    if (!paths.some((p) => p.startsWith('src/') && p !== APP_SDK_FILE && CODE.test(p))) e.push('no source files in src/');
    push('layout', e);
  }

  // dependencies
  {
    const e: string[] = [];
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; optionalDependencies?: object; peerDependencies?: object } = {};
    try {
      pkg = files['package.json'] ? JSON.parse(text('package.json')) : {};
    } catch {
      e.push('package.json is not valid JSON');
    }
    const pinned = (v: string) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
    for (const [kind, allowed, deps] of [
      ['dependency', RUNTIME_DEPENDENCIES, pkg.dependencies ?? {}],
      ['dev dependency', DEV_DEPENDENCIES, pkg.devDependencies ?? {}],
    ] as const) {
      for (const [name, version] of Object.entries(deps)) {
        if (!allowed.includes(name)) e.push(`${kind} ${name} is not on the allow-list (${allowed.join(', ')})`);
        if (!pinned(String(version))) e.push(`${kind} ${name}@${String(version)} is not pinned to an exact version`);
      }
    }
    if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length) e.push('optionalDependencies are not allowed');
    for (const s of INSTALL_SCRIPTS) if (pkg.scripts?.[s]) e.push(`install script "${s}" is not allowed`);
    push('dependencies pinned and allowed', e);
  }

  // only the SDK
  {
    const e: string[] = [];
    if (files[APP_SDK_FILE] && text(APP_SDK_FILE) !== input.sdk.replace(/\r\n/g, '\n')) {
      const first = text(APP_SDK_FILE).split('\n')[0] ?? '';
      e.push(`${APP_SDK_FILE} differs from the SDK of the ontology in force (${input.sdk.split('\n')[0]?.replace(/^\/\/\s*/, '')}); the file has: ${first.replace(/^\/\/\s*/, '').slice(0, 120)}`);
    }
    for (const p of paths.filter((x) => (x.startsWith('src/') || /^[^/]+\.(m?[jt]s|cjs)$/.test(x)) && CODE.test(x) && x !== APP_SDK_FILE)) {
      const src = text(p);
      for (const [re, what] of FORBIDDEN) if (re.test(src)) e.push(`${p}: ${what}`);
      for (const m of src.matchAll(IMPORT)) {
        const spec = m[1]!;
        const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        const isConfig = !p.startsWith('src/'); // vite.config.ts may import the build tools
        if (spec.startsWith('./') || spec.startsWith('../')) continue;
        if (RUNTIME_DEPENDENCIES.includes(pkgName)) continue;
        if (isConfig && (DEV_DEPENDENCIES.includes(pkgName) || spec.startsWith('node:'))) continue;
        e.push(`${p}: imports ${spec}`);
      }
    }
    push('uses only the SDK', e);
  }

  // actions and classes
  {
    const e: string[] = [];
    if (!input.actions.length && !input.reads.length) e.push('the app is registered for no action and no class');
    for (const a of input.actions) if (!input.ontology.actions.includes(a)) e.push(`unknown action ${a}`);
    for (const c of input.reads) if (!input.ontology.classes.includes(c)) e.push(`unknown class ${c}`);
    push('actions and classes exist', e);
  }

  // bundle
  {
    const e: string[] = [];
    if (files['dist/index.html']) {
      const html = text('dist/index.html');
      for (const m of html.matchAll(/<(script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        if (/^(?:[a-z]+:)?\/\//i.test(m[2]!)) e.push(`dist/index.html loads ${m[2]} from another origin`);
      }
      if (/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) e.push('dist/index.html has an inline script (blocked by the app host CSP)');
    }
    push('bundle loads nothing from elsewhere', e);
  }
  return checks;
}
