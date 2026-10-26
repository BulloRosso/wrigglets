# Documentation

| Document | For whom | Content |
|---|---|---|
| [getting-started.md](getting-started.md) | everyone | run the stack on Docker Desktop, create an agent, walk through the reference scenario |
| [architecture.md](architecture.md) | developers, architects | complete technical documentation with diagrams, APIs, configuration, verification, spec conformance |
| [entra-obo.md](entra-obo.md) | architects, admins | optional Microsoft Entra On-Behalf-Of: MCP calls with agent and user identity (Foundry model), set-up, rules, operations |
| [exfiltration-guard.md](exfiltration-guard.md) | everyone, security | the pre-tool-call evaluation agent against multi-turn prompt injection and data exfiltration: flow, configuration, limits |
| [red-teaming.md](red-teaming.md) | security, developers | a runnable red-team example against a real agent with a mock MCP server (no auth), scenarios and measured results |
| [azure.md](azure.md) | architects, platform team | Azure resource types, mapping, technical implications, migration checklist |
| [runbook.md](runbook.md) | operators | restart, stuck lock, failed tasks, restore, secret rotation, upgrades |
| [adr/](adr/README.md) | everyone | Architecture Decision Records (20) |
| [diagrams/](diagrams/) | | SVG diagrams used in the documents |
| [images/](images/) | | screenshots of the running system |

Source specification: [`../agent-implementation-spec.md`](../agent-implementation-spec.md).
