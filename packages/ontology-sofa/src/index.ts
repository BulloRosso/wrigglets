import { readFileSync } from 'node:fs';
import { verifyIr, type OntologyIr } from '@cw/ontology-ir';

/*
 * The sofa company's compiled ontology (the built-in version of the enterprise core). The IR is read from
 * ir/ontology.ir.json at runtime (hash-verified). Generated code: the SDK for apps and the types (development aid).
 * Tools, validation, DDL, DQ checks and OPA data are computed from the IR at runtime (ADR-0049).
 * Edit ontology/sofa/*.yaml and run node scripts/liquid/ontology-build.mjs.
 */
let cached: OntologyIr | undefined;
export function loadIr(): OntologyIr {
  return (cached ??= verifyIr(JSON.parse(readFileSync(new URL('../ir/ontology.ir.json', import.meta.url), 'utf8'))));
}

export * as types from './generated/types.js';
export { createClient, OntologyError, type ClientOptions, type OntologyClient } from './generated/sdk.js';
