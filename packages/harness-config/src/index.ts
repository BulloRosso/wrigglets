/*
 * Agent Harness (opencode 1.19.x) configuration.
 *
 * Verified against opencode 1.19.4 (see docs/adr/0007-harness-configuration.md):
 *  - Permission rules are ORDERED and the LAST matching rule wins. A catch-all `"*": "deny"` must
 *    therefore come FIRST, followed by the explicit allows. (With the catch-all last, opencode
 *    removes the bash tool entirely.)
 *  - `doom_loop` and `question` default to "ask", which would block a headless step → deny.
 *  - The config lives OUTSIDE the workspace (OPENCODE_CONFIG) and OPENCODE_DISABLE_PROJECT_CONFIG
 *    makes opencode ignore any `opencode.json` in the workspace. That flag also disables automatic
 *    AGENTS.md discovery, so AGENTS.md is referenced explicitly via `instructions`.
 */

export interface HarnessConfigInput {
  workspaceDir: string;
  /** Model reference `<provider>/<model>`; provider must be `aigateway`. */
  model: string;
  /** Optional cheaper model for titles/summaries. */
  smallModel?: string;
  /** Additional model ids to declare in the provider block. */
  extraModels?: string[];
  /** MCP gateway endpoint of this agent (ADR-0021); the only MCP server the harness may use. */
  mcpGatewayUrl?: string;
}

export const HARNESS_PROVIDER_ID = 'aigateway';

export function renderHarnessConfig(input: HarnessConfigInput): Record<string, unknown> {
  const modelId = (ref: string) => (ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref);
  const models = new Set([modelId(input.model), ...(input.smallModel ? [modelId(input.smallModel)] : []), ...(input.extraModels ?? [])]);
  const ws = input.workspaceDir.replace(/\/$/, '');
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    provider: {
      [HARNESS_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'AI gateway',
        options: {
          baseURL: '{env:AI_GATEWAY_BASE_URL}',
          apiKey: '{env:AI_GATEWAY_API_KEY}',
        },
        models: Object.fromEntries([...models].map((m) => [m, { name: m }])),
      },
    },
    enabled_providers: [HARNESS_PROVIDER_ID],
    model: `${HARNESS_PROVIDER_ID}/${modelId(input.model)}`,
    small_model: `${HARNESS_PROVIDER_ID}/${modelId(input.smallModel ?? input.model)}`,
    instructions: [`${ws}/AGENTS.md`],
    ...(input.mcpGatewayUrl
      ? {
          mcp: {
            gateway: {
              type: 'remote',
              url: input.mcpGatewayUrl,
              headers: { Authorization: 'Bearer {env:MCP_GATEWAY_TOKEN}' },
              oauth: false,
              timeout: 120_000,
            },
          },
        }
      : {}),
    permission: {
      read: 'allow',
      edit: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      todowrite: 'allow',
      webfetch: 'deny',
      websearch: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      external_directory: 'deny',
      task: 'deny',
      skill: 'deny',
      lsp: 'deny',
      // MCP tools of the gateway (`gateway_<upstream>__<tool>`); allow-list and kill switch are enforced in the gateway.
      ...(input.mcpGatewayUrl ? { 'gateway_*': 'allow' } : {}),
      // ORDER MATTERS: catch-all first, explicit allows after (last match wins).
      bash: {
        '*': 'deny',
        'git status*': 'allow',
        'git diff*': 'allow',
        'git log*': 'allow',
        'git show*': 'allow',
        'ls*': 'allow',
        'cat *': 'allow',
        'head *': 'allow',
        'wc *': 'allow',
        'rg *': 'allow',
        [`python3 ${ws}/scripts/*`]: 'allow',
        'python3 scripts/*': 'allow',
      },
    },
  };
}

/** Environment flags that harden opencode for headless, governed use. */
export const HARNESS_HARDENING_ENV: Record<string, string> = {
  OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_DISABLE_CLAUDE_CODE: 'true',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
};

export interface AgentsMdInput {
  agentId: string;
  displayName: string;
}

/** Standing instructions written to `/home/workspace/AGENTS.md` when the workspace is created. */
export function renderAgentsMd(input: AgentsMdInput): string {
  return `# ${input.displayName} — standing instructions

You are **${input.displayName}** (agent id \`${input.agentId}\`), an AI colleague working for a team.
Several people give you tasks. You work on ONE shared data set: this Git repository.

## Tone and role
- Be precise, factual and concise. Write for busy colleagues.
- If information is missing or ambiguous, state your assumptions explicitly in the plan or summary.

## Hard rules
- **Never commit, reset, push or rewrite Git history.** The platform commits after every step.
- Only change files that the current task requires.
- Never modify \`AGENTS.md\`, \`opencode.json\`, anything under \`.git/\`, \`.agent/audit/\` or \`.agent/steps/\`.
- Never access the network. The only permitted shell commands are read-only inspection commands
  and scripts under \`scripts/\`.

## Folder conventions
- \`.agent/plans/<taskId>.md\` — the plan for a task (written in the planning step).
- \`.agent/summaries/<stepId>.md\` — a 3–6 sentence summary after every step.
- \`reports/\` — reports and analysis results.
- \`scripts/verify/<type>.py\` — optional verification scripts run by the platform (do not edit unless asked).
- Team data (documents, CSV files, …) lives in the remaining folders; keep their structure.
`;
}
