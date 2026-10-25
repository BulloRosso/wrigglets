import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';

/**
 * Custom search attributes (spec §7.3). They are registered once per namespace:
 * locally by `temporal server start-dev --search-attribute …` (admin-server supervisor),
 * on Azure by `infra/temporal/bootstrap.sh`.
 */
export const SA = {
  AgentId: defineSearchAttributeKey('AgentId', SearchAttributeType.KEYWORD),
  RequestedBy: defineSearchAttributeKey('RequestedBy', SearchAttributeType.KEYWORD),
  TaskType: defineSearchAttributeKey('TaskType', SearchAttributeType.KEYWORD),
  TaskStatus: defineSearchAttributeKey('TaskStatus', SearchAttributeType.KEYWORD),
  TaskTitle: defineSearchAttributeKey('TaskTitle', SearchAttributeType.TEXT),
  Trigger: defineSearchAttributeKey('Trigger', SearchAttributeType.KEYWORD),
  ScheduleId: defineSearchAttributeKey('ScheduleId', SearchAttributeType.KEYWORD),
  ApprovedBy: defineSearchAttributeKey('ApprovedBy', SearchAttributeType.KEYWORD_LIST),
} as const;

/** `name=Type` pairs in the format expected by `temporal server start-dev --search-attribute`. */
export const SEARCH_ATTRIBUTE_CLI_DEFINITIONS: Array<[string, string]> = [
  ['AgentId', 'Keyword'],
  ['RequestedBy', 'Keyword'],
  ['TaskType', 'Keyword'],
  ['TaskStatus', 'Keyword'],
  ['TaskTitle', 'Text'],
  ['Trigger', 'Keyword'],
  ['ScheduleId', 'Keyword'],
  ['ApprovedBy', 'KeywordList'],
];

/** Escapes a value for use inside a single-quoted visibility query literal. */
export const q = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
