import type { OntologyIr } from '@cw/ontology-ir';
import { genDq } from './gen-dq.js';
import { genMcp } from './gen-mcp.js';
import { genOpaData, genOpaTest } from './gen-opa.js';
import { genSdk } from './gen-sdk.js';
import { genSql } from './gen-sql.js';
import { genTypes } from './gen-types.js';
import type { Files } from './util.js';

export { dqChecks, type DqCheck } from './gen-dq.js';
export { mcpTools, type McpToolDef } from './gen-mcp.js';
export { opaData } from './gen-opa.js';
export { genDq, genMcp, genOpaData, genOpaTest, genSdk, genSql, genTypes };
export { snake, tableOf, camel, pascal, type Files } from './util.js';

/**
 * Every generated artefact of an ontology, as paths relative to its package (packages/ontology-<name>).
 * Pure: the same IR always gives the same bytes.
 */
export function generateAll(ir: OntologyIr): Files {
  return {
    'src/generated/types.ts': genTypes(ir),
    'src/generated/mcp-tools.ts': genMcp(ir),
    'src/generated/dq.ts': genDq(ir),
    'src/generated/sdk.ts': genSdk(ir),
    'generated/projection.sql': genSql(ir),
    'generated/opa/data.json': genOpaData(ir),
    'generated/opa/ontology_test.rego': genOpaTest(ir),
  };
}
