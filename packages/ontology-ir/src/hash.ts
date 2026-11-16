import { createHash } from 'node:crypto';
import { canonical, ontologyIr, type OntologyIr } from './ir.js';

/* Hashing and verification (Node only; the browser entry @cw/ontology-ir/browser leaves this out). */

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Hash of a source file as the compiler computes it (CRLF normalised to LF). */
export const sourceHash = (text: string) => sha256(text.replace(/\r\n/g, '\n'));

export function irHash(ir: Omit<OntologyIr, 'hash'> & { hash?: string }): string {
  const { hash: _h, ...rest } = ir;
  return sha256(canonical(rest));
}

/** Parses and checks an IR document: schema, references, and that its content hash matches. */
export function verifyIr(doc: unknown): OntologyIr {
  const ir = ontologyIr.parse(doc);
  const h = irHash(ir);
  if (h !== ir.hash) throw new Error(`ontology IR hash mismatch: file says ${ir.hash.slice(0, 12)}, content is ${h.slice(0, 12)} (edited by hand?)`);
  return ir;
}
