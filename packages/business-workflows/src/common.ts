import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';

/*
 * Shared definitions of the business workflows (ADR-0045): search attributes, activity contract.
 * Namespace `business`, task queue `business`, worker apps/business-worker.
 */

export const BUSINESS_NAMESPACE = 'business';
export const BUSINESS_TASK_QUEUE = 'business';

export const BSA = {
  /** Ontology objects a workflow touches, e.g. `PurchaseOrder:PO-4430`, `Supplier:S-NORDHOLZ` (blast radius, holds). */
  OntologyObjects: defineSearchAttributeKey('OntologyObjects', SearchAttributeType.KEYWORD_LIST),
  /** Business state, e.g. awaiting_release, held, awaiting_delivery, received, pending_approval, executed. */
  BusinessState: defineSearchAttributeKey('BusinessState', SearchAttributeType.KEYWORD),
} as const;

/** `name=Type` pairs to register in the business namespace. */
export const BUSINESS_SEARCH_ATTRIBUTES: Array<[string, string]> = [
  ['OntologyObjects', 'KeywordList'],
  ['BusinessState', 'Keyword'],
];

export const objectRef = (cls: string, id: string) => `${cls}:${id}`;

export interface ActionCaller {
  agent?: string;
  user?: string;
  task?: string;
  workflow?: string;
  /** Person who approved a four-eyes request (only accepted from trusted callers, never from MCP). */
  approvedBy?: string;
}

export interface ActionOutcome {
  ok: boolean;
  result: string;
  seq?: number;
}

/** Activities the business worker implements (all I/O goes through the ontology server: actions are the write path). */
export interface BusinessActivities {
  runAction(i: { action: string; args: Record<string, unknown>; caller: ActionCaller }): Promise<ActionOutcome>;
  getObject(i: { cls: string; id: string }): Promise<Record<string, unknown> | null>;
  flushLake(): Promise<{ flushed: number; hwm: number }>;
  notify(i: { kind: string; subject: string; body: string; ref: string }): Promise<void>;
}
