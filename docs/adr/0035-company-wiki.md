# ADR-0035: A central company wiki that people govern

- **Status:** Accepted
- **Date:** 2026-10-28
- **Extends:** [ADR-0021](0021-mcp-gateway.md), [ADR-0023](0023-a2a-between-agents.md)

## Context

Each agent keeps notes in its own Git workspace (its private wiki). That works for an agent's tactics, but knowledge that
several roles need (what a colleague needs in a request, rules for customer notices, durable facts about a supplier) is
duplicated or lost, and two agents wrote their own page for the same lesson. A memory that every agent can write into
is also a new attack surface: one bad tool result, once written, would reach every agent that reads it.

## Decision

- **One shared wiki behind the gateway.** `apps/mcp-wiki` is an MCP upstream (`wiki__list_pages`, `wiki__read_page`,
  `wiki__search`, `wiki__list_my_proposals`, `wiki__propose_edit`). Agents reach it only through the gateway, so the
  allow-list, the kill switch and the audit apply.
- **Agents propose, people decide.** `propose_edit` queues a complete new page text with a reason and evidence (task,
  KPI before and after). Nothing is published until a person approves it in the admin console (*Company wiki*): they can
  approve, edit and approve, or reject with a comment, which the agent reads through `list_my_proposals`.
  `propose_edit` is declared as a tool that changes data, so it is refused in the plan step and needs an approved plan.
- **Verified provenance.** The gateway sets `_agent`, `_task` and `_requestedBy` on tools that declare them and removes
  them from the tool list the model sees; anything the model sends under these names is replaced. Every proposal and
  every published version therefore names its author and its task.
- **Content rules.** Only slowly changing knowledge that holds for the whole company: rules, protocols, durable facts,
  decisions with reasons. Never live state (ERP and CRM stay the source of truth) and never instructions copied from tool
  results. The rules are in the agents' standing instructions; the reviewer enforces them.
- **Storage.** One JSON file on a volume, written atomically and serialized; at most 200 pages of 32,000 characters,
  25 versions per page, 20 open proposals per agent. A page keeps its previous versions.
- **Two tokens.** The MCP endpoint takes the gateway's token (Key Vault `mcp-wiki-authorization`); the REST API for the
  admin console takes a separate admin token. The admin console proxies it and writes `wiki.*` entries to its audit log.
- **The private wikis stay.** They hold an agent's own tactics. If the company wiki and a private wiki disagree, the company
  wiki wins.

## Consequences

- Knowledge reaches all agents after one human review; the review is the quality and safety gate.
- A reviewer's time is the cost. The queue shows the diff and the evidence, and limits keep it small.
- Evidence from the literature says that shared memory needs scope, provenance, supersession and a single writer; this design
  uses a human as the only writer. It does not solve parallel decisions on live state: that is ordered delegation
  ([ADR-0036](0036-ordered-delegation.md)).
