import type { OntologyIr } from '@cw/ontology-ir';
import { camel, header, js, pascal } from './util.js';

/*
 * SDK for UIs (M9 completes it): a typed client of the ontology server's REST API — objects per class (list, get) and
 * one method per action. Uses only fetch against the configured base URL with a bearer token; no other network access.
 */

export function genSdk(ir: OntologyIr): string {
  const typeImports = [...ir.classes.map((c) => c.name), ...ir.actions.map((a) => `${pascal(a.name)}Input`)];
  const out: string[] = [header(ir, '//'), `import type { ${typeImports.join(', ')} } from './types.js';`, ''];
  out.push(
    'export interface ClientOptions {',
    '  /** Base URL of the ontology server REST API, e.g. https://onto.example/api */',
    '  baseUrl: string;',
    '  /** OIDC access token provider (the app registry issues the client, M9). */',
    '  token: () => string | Promise<string>;',
    '  fetch?: typeof fetch;',
    '}',
    '',
    'export class OntologyError extends Error {',
    '  constructor(readonly status: number, message: string, readonly body?: unknown) {',
    '    super(message);',
    '  }',
    '}',
    '',
    `export function createClient(o: ClientOptions) {`,
    `  const f = o.fetch ?? fetch;`,
    `  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {`,
    `    const res = await f(\`\${o.baseUrl.replace(/\\/$/, '')}\${path}\`, { method, headers: { authorization: \`Bearer \${await o.token()}\`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });`,
    `    const json = await res.json().catch(() => undefined);`,
    `    if (!res.ok) throw new OntologyError(res.status, (json as { error?: string } | undefined)?.error ?? res.statusText, json);`,
    `    return json as T;`,
    `  };`,
    `  const objects = <T>(cls: string) => ({`,
    `    list: (params: Record<string, string> = {}) => call<T[]>('GET', \`/objects/\${cls}?\${new URLSearchParams(params)}\`),`,
    `    get: (id: string) => call<T>('GET', \`/objects/\${cls}/\${encodeURIComponent(id)}\`),`,
    `  });`,
    `  return {`,
    `    ontology: ${js({ name: ir.name, version: ir.version, hash: ir.hash })},`,
    `    objects: {`,
  );
  for (const c of ir.classes) out.push(`      ${camel(c.name.charAt(0).toLowerCase() + c.name.slice(1))}: objects<${c.name}>(${js(c.name)}),`);
  out.push('    },', '    actions: {');
  for (const a of ir.actions) out.push(`      /** ${a.description.replace(/\*\//g, '*\\/').slice(0, 160)}${a.description.length > 160 ? '…' : ''} */`, `      ${camel(a.name)}: (input: ${pascal(a.name)}Input) => call<unknown>('POST', '/actions/${a.name}', input),`);
  out.push('    },', '  };', '}', '', 'export type OntologyClient = ReturnType<typeof createClient>;', '');
  return out.join('\n');
}
