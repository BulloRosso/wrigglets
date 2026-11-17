import type { IrAttribute, IrInput, OntologyIr } from '@cw/ontology-ir';
import { camel, js, pascal } from './util.js';

/*
 * SDK for registered apps (ADR-0050): one standalone TypeScript file, no dependencies. Apps are served by the app host
 * of the control plane on their own origin; the host signs the person in, holds the session and forwards only the
 * app's registered actions and reads to the enterprise core. So the client never holds a token and only calls its own
 * origin (relative URLs, cookies same-origin). The registry accepts an app only if its copy of this file is
 * byte-identical to the SDK of the ontology in force — the static guarantee that the app talks to nothing else.
 */

export const APP_SDK_PATH = 'src/liquid-sdk.ts';
export const appSdkHeader = (ir: OntologyIr) => `// GENERATED SDK for apps — ontology ${ir.name}@${ir.version} (${ir.hash.slice(0, 12)}); do not edit (download it from the app registry)\n`;

function tsScalar(range: string): string {
  switch (range) {
    case 'integer':
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'json':
      return 'unknown';
    default:
      return 'string';
  }
}

function tsOf(f: Pick<IrAttribute, 'range' | 'rangeKind' | 'multivalued'> & { enum?: string[] }): string {
  let t: string;
  if (f.enum?.length) t = f.enum.map((v) => js(v)).join(' | ');
  else if (f.rangeKind === 'enum') t = f.range;
  else if (f.rangeKind === 'class') t = 'string';
  else t = tsScalar(f.range);
  return f.multivalued ? `Array<${t}>` : t;
}

const doc = (s: string | undefined) => (s ? `  /** ${s.replace(/\*\//g, '*\/').slice(0, 200)} */` : undefined);

export function genAppSdk(ir: OntologyIr): string {
  const out: string[] = [appSdkHeader(ir)];
  out.push(`export const ONTOLOGY = { name: ${js(ir.name)}, version: ${js(ir.version)}, hash: ${js(ir.hash)} } as const;`, '');
  for (const e of ir.enums) out.push(`export type ${e.name} = ${e.values.map((v) => js(v.value)).join(' | ')};`);
  out.push('');
  for (const c of ir.classes) {
    out.push(`/** ${(c.description ?? c.name).replace(/\*\//g, '')} */`, `export interface ${c.name} {`);
    for (const a of c.attributes) {
      const d = doc(a.description);
      if (d) out.push(d);
      const req = a.required || a.identifier;
      out.push(`  ${a.name}${req ? '' : '?'}: ${tsOf(a)}${req ? '' : ' | null'};`);
    }
    out.push('}', '');
  }
  for (const a of ir.actions) {
    out.push(`export interface ${pascal(a.name)}Input {`);
    for (const f of a.input as IrInput[]) {
      const d = doc(f.description);
      if (d) out.push(d);
      out.push(`  ${f.name}${f.required ? '' : '?'}: ${tsOf(f)};`);
    }
    out.push('}', '');
  }
  out.push(
    'export interface ActionResult {',
    '  ok: boolean;',
    '  /** The answer of the action (text, often JSON). */',
    '  result: string;',
    '  /** Position of the event in the log when something was written. */',
    '  seq?: number;',
    '}',
    '',
    'export class OntologyError extends Error {',
    '  constructor(readonly status: number, message: string, readonly body?: unknown) {',
    '    super(message);',
    '  }',
    '}',
    '',
    '/** Client of the app host. `base` is relative to the app (default "api"): the host forwards it to the enterprise core. */',
    "export function createClient(base = 'api') {",
    '  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {',
    "    const res = await fetch(`${base.endsWith('/') ? base.slice(0, -1) : base}${path}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-liquid-app': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });",
    '    const json = await res.json().catch(() => undefined);',
    '    if (!res.ok) throw new OntologyError(res.status, (json as { error?: string; result?: string } | undefined)?.error ?? (json as { result?: string } | undefined)?.result ?? res.statusText, json);',
    '    return json as T;',
    '  };',
    '  const objects = <T>(cls: string) => ({',
    '    list: () => call<T[]>(\'GET\', `/objects/${cls}`),',
    '    get: (id: string) => call<T>(\'GET\', `/objects/${cls}/${encodeURIComponent(id)}`),',
    '  });',
    '  return {',
    '    ontology: ONTOLOGY,',
    '    /** Who is signed in to this app (name, upn). */',
    "    me: () => call<{ upn: string; name: string; app: string }>('GET', '/me'),",
    '    objects: {',
  );
  for (const c of ir.classes) out.push(`      ${camel(c.name.charAt(0).toLowerCase() + c.name.slice(1))}: objects<${c.name}>(${js(c.name)}),`);
  out.push('    },', '    actions: {');
  for (const a of ir.actions) {
    out.push(`      /** ${a.description.replace(/\*\//g, '*\/').slice(0, 160)}${a.description.length > 160 ? '…' : ''} */`, `      ${camel(a.name)}: (input: ${pascal(a.name)}Input) => call<ActionResult>('POST', '/actions/${a.name}', input),`);
  }
  out.push('    },', '  };', '}', '', 'export type OntologyClient = ReturnType<typeof createClient>;', '');
  return out.join('\n');
}
