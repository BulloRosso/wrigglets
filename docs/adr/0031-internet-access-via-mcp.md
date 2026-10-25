# ADR-0031: Internet access for agents through an MCP upstream behind the gateway

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Agents such as Lara need current information from the internet, e.g. a share price or a supplier's website. opencode
has built-in `webfetch` and `websearch` tools, but they run inside the agent container. That would bypass the MCP
gateway's per-agent allow-list, the kill switch, the rate limits and the tool-call audit (ADR-0021/0022), and it would
need outbound access from every agent container.

## Decision

- The built-in tools stay **denied** in the harness. Internet access is a separate upstream MCP server, **`mcp-web`**
  (TypeScript, own container), registered in the gateway as upstream `web`. Its bearer token is in Key Vault as
  `mcp-web-authorization`.
- **Tools:**
  - `web__search {query, max_results}`: web search via DuckDuckGo's HTML endpoint. No API key is needed; it is best
    effort and returns titles, URLs and snippets.
  - `web__fetch_url {url, max_chars}`: reads a public page, with HTML converted to readable text and links kept as
    Markdown; text and JSON are also supported. At most 3 MB are downloaded and at most 60,000 characters returned.
- **Access per agent** like any other tool: an admin allows `web__search` and `web__fetch_url` on the agent's *Safety*
  tab, e.g. for Lara only. Every call is audited by the gateway and subject to the kill switch (`tools_off` blocks it).
- **No SSRF:**
  - Only `http(s)` URLs without credentials are accepted.
  - Host names are resolved, and private, loopback, link-local, CGNAT, multicast and metadata addresses (IPv4, IPv6
    and IPv4-mapped) are refused.
  - Every redirect hop is checked again.
  - Internal names (`localhost`, `*.local`, `*.internal`) are refused.

  The tool can therefore not reach the Docker network, the host or LiteLLM.

## Consequences

- Outbound web access is concentrated in one container that can be monitored or given an egress proxy. On Azure this
  is a Container App with a NAT gateway or firewall rules.
- Search quality depends on DuckDuckGo's HTML endpoint. A search API (e.g. Bing or Brave) can replace it behind the
  same tool contract.
- Content from the web is untrusted input for the model. The harness still cannot run arbitrary commands, and every
  change still goes through plan approval and verification.
