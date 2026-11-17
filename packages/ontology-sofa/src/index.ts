import { readFileSync } from 'node:fs';
import { verifyIr, type OntologyIr } from '@cw/ontology-ir';

/*
 * The sofa company's compiled ontology (the built-in version of the enterprise core). The IR is read from
 * ir/ontology.ir.json at runtime (hash-verified). Tools, validation, DDL, DQ checks, OPA data and the SDK are computed
 * from the IR at runtime (ADR-0049, ADR-0053); nothing generated is committed.
 * Edit ontology/sofa/*.yaml and run node scripts/liquid/ontology-build.mjs.
 */
let cached: OntologyIr | undefined;
export function loadIr(): OntologyIr {
  return (cached ??= verifyIr(JSON.parse(readFileSync(new URL('../ir/ontology.ir.json', import.meta.url), 'utf8'))));
}

