import { readFileSync } from 'node:fs';
import { verifyIr, type OntologyIr } from '@cw/ontology-ir';

/*
 * The sofa company's compiled ontology. The IR is read from ir/ontology.ir.json at runtime (hash-verified), the
 * generated modules are re-exported. Edit ontology/sofa/*.yaml and run node scripts/liquid/ontology-build.mjs.
 */
let cached: OntologyIr | undefined;
export function loadIr(): OntologyIr {
  return (cached ??= verifyIr(JSON.parse(readFileSync(new URL('../ir/ontology.ir.json', import.meta.url), 'utf8'))));
}
export const projectionSql = () => readFileSync(new URL('../generated/projection.sql', import.meta.url), 'utf8');
export const opaData = () => JSON.parse(readFileSync(new URL('../generated/opa/data.json', import.meta.url), 'utf8')) as Record<string, unknown>;

export * as types from './generated/types.js';
export { MCP_TOOLS, type McpToolName } from './generated/mcp-tools.js';
export { DQ_CHECKS, type DqCheck } from './generated/dq.js';
export { createClient, OntologyError, type ClientOptions, type OntologyClient } from './generated/sdk.js';
