import type { OntologyIr } from '@cw/ontology-ir';
import { genDq } from './gen-dq.js';
import { genMcp } from './gen-mcp.js';
import { genOpaData, genOpaTest } from './gen-opa.js';
import { genSql } from './gen-sql.js';
import type { Files } from './util.js';

export { dqChecks, type DqCheck } from './gen-dq.js';
export { mcpTools, type McpToolDef } from './gen-mcp.js';
export { opaData } from './gen-opa.js';
export { genDq, genMcp, genOpaData, genOpaTest, genSql };
export { genAppSdk, appSdkHeader, APP_SDK_PATH } from './gen-app-sdk.js';
export { snake, tableOf, camel, pascal, type Files } from './util.js';

/*
 * Since ADR-0049 the enterprise core interprets the IR at runtime: tools, validation, DDL, DQ checks and OPA data come
 * from the functions above; since ADR-0053 nothing generated is committed — the one SDK (genAppSdk) is served at
 * runtime from the ontology in force.
 */

/** Fixtures for `opa test` of the policies (written to a temp dir by scripts/liquid/check.mjs, not committed). */
export function opaTestFixtures(ir: OntologyIr): Files {
  return { 'data.json': genOpaData(ir), 'ontology_test.rego': genOpaTest(ir) };
}
