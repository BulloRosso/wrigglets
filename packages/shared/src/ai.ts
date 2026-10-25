/** AI gateway (LiteLLM → OpenAI) status, model prices and agent spend (ADR-0029). */

/** Spend limits are evaluated over this rolling window. */
export const SPEND_WINDOW_DAYS = 30;

/** Task budgets are no longer limited in tokens; the agent's USD spend limit applies instead. */
export const UNLIMITED_TOKENS = Number.MAX_SAFE_INTEGER;

export interface AiModelInfo {
  name: string;
  /** USD per 1 million tokens, from LiteLLM's model cost map (current OpenAI prices). */
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
  cachedInputUsdPer1M?: number;
  contextTokens?: number;
}

export interface AiStatus {
  /** true = a real model can be used: OPENAI_API_KEY is set and LiteLLM is reachable. */
  configured: boolean;
  reachable: boolean;
  /** What is wrong, in plain words (undefined when configured). */
  problem?: string;
  /** What must be configured to fix it. */
  howToFix?: string;
  models: AiModelInfo[];
  defaultModel: string;
  /** LiteLLM admin UI for operators. */
  gatewayUrl?: string;
  checkedAt: string;
}

export interface AgentSpend {
  agentId: string;
  model: string;
  /** Spend of the agent's virtual key within the last SPEND_WINDOW_DAYS days (USD). */
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  exceeded: boolean;
  windowDays: number;
  since: string;
  ai: Pick<AiStatus, 'configured' | 'reachable' | 'problem' | 'howToFix'>;
  checkedAt: string;
}

/** The agent's LiteLLM virtual key as shown in the admin console (never the full key). */
export interface AiKeyInfo {
  masked: string;
  alias?: string;
  createdAt?: string;
  blocked: boolean;
  /** LiteLLM key budget (backstop of the spend limit). */
  maxBudgetUsd?: number;
  budgetDuration?: string;
  budgetResetAt?: string;
  /** Spend since the last LiteLLM budget reset. */
  periodSpendUsd: number;
  /** Models the key may use (empty = all). */
  models: string[];
}

/** Everything the admin console shows on an agent's AI & budget tab. */
export interface AgentAiDetails {
  spend: AgentSpend;
  key?: AiKeyInfo;
  keyError?: string;
  daily: Array<{ date: string; usd: number }>;
  smallModel: string;
}

export const formatUsd = (v: number | undefined) =>
  v === undefined ? '–' : `$${v < 1 && v > 0 ? v.toFixed(v < 0.01 ? 4 : 3) : v.toFixed(2)}`;
