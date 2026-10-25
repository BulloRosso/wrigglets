# ADR-0026: Human in the loop by e-mail — mail API or outbox, deep links into the decision dialog

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Approvals only work if people notice that an agent is waiting. Users are usually not looking at the agent UI, so an
agent must be able to reach them. Mail configuration should be hard to get wrong: no SMTP settings per agent and no
mail credentials in agent containers.

## Decision

- **Who is asked:** when a task waits for a decision (`approval_requested`, and again for `approval_reminder`), the
  agent asks **all users with access to it**: every enabled user with a role for this agent, directly or through the
  `*` (all agents) role. Platform admins are only included if they have such a role. The usual rules still apply:
  only approvers or the requester can decide, and the first decision counts.
- **Who sends:** the agent's `notify` activity calls the control plane at `POST /internal/agents/<id>/notify` with its
  internal token. The control plane, which knows users and roles, resolves the recipients, renders the HTML and
  delivers the mail. Agents never hold mail credentials or user lists.
- **Delivery contract:** one HTTP endpoint, `MAIL_API_URL`, called as `POST { "to": string[], "subject": string,
  "body": string (HTML) }`, with an optional `Authorization: Bearer MAIL_API_KEY`. Any mail service or Logic App can
  sit behind it.
- **Without a mail API:** the mail is written as an HTML file to `mail_out/` on the control-plane volume. The mail is
  **always** stored as `<id>.html` plus `<id>.json` metadata (recipients, status `sent` / `failed` / `written`),
  including when it is delivered.
- **Admin review:** the admin console's *Mail outbox* shows every mail. The stored HTML is rendered in a sandboxed
  iframe (`sandbox`, CSP without scripts or external resources).
- **Deep links:** the mail has buttons for *Approve*, *Request changes* and *Reject*, which link to
  `/tasks/<id>?decide=approve|revise|reject`. A link to `?decide=review` opens the task and scrolls to the decision
  card.
  - The agent UI opens the matching confirmation dialog after sign-in; the return URL is kept through the OIDC flow.
  - **A link never decides anything by itself.** The decision is still made in the UI, by an authenticated user, and
    is validated by the workflow update.
- **Best effort:** a failed mail is logged and visible in the outbox, but it does not fail the activity. Retrying the
  activity would duplicate the in-app notifications.

## Consequences

- One place to configure mail (the control plane), and an audit entry (`mail.approval`) per mail.
- E-mail content contains the task title and the agent's short status text, but no plan content.
- Azure: `MAIL_API_URL` points to an Azure Communication Services Email wrapper or a Logic App (managed identity);
  `mail_out` lives on the control plane's Azure Files share.
