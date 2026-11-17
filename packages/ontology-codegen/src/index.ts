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
export { genAppSdk, appSdkHeader, APP_SDK_PATH } from './gen-app-sdk.js';
export { snake, tableOf, camel, pascal, type Files } from './util.js';

/**
 * The generated files of an ontology package (packages/ontology-<name>), as paths relative to it. Since ADR-0049 the
 * enterprise core interprets the IR at runtime (tools, validation, DDL, DQ, OPA data come from the functions above at
 * runtime), so only the SDK for apps (and the types, a development aid for handler code) are written as files.
 * Pure: the same IR always gives the same bytes.
 */
export function generateAll(ir: OntologyIr): Files {
  return {
    'src/generated/types.ts': genTypes(ir),
    'src/generated/sdk.ts': genSdk(ir),
  };
}

/** Fixtures for `opa test` of the policies (written to a temp dir by scripts/liquid/check.mjs, not committed). */
export function opaTestFixtures(ir: OntologyIr): Files {
  return { 'data.json': genOpaData(ir), 'ontology_test.rego': genOpaTest(ir) };
}
