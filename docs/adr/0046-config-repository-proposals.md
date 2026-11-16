# ADR-0046: Desired state in a config repository; proposals and reconciler

- **Status:** Accepted
- **Date:** 2026-11-16
- **Supersedes in part:** the storage of [ADR-0021](0021-mcp-gateway.md) (gateway upstreams, allow-lists) and [ADR-0022](0022-kill-switch.md) (safety rules) while Liquid Enterprise is installed
- **Extends:** [ADR-0042](0042-ontology-editor-react-flow.md) (editor E2/E3), [ADR-0044](0044-policy-as-code-opa.md) (overlays, bundle source)

## Context

Plan M6: the platform's behaviour-defining configuration should live in Git, be changed through reviewed proposals by
agents and people, and be applied by a reconciler. The admin server keeps its JSON stores in `/data/admin`; agents
must be able to ask for changes (e.g. a tool they lack) without being able to make them.

## Decision

1. **A bare Git repository** at `/data/liquid/config.git` (control-plane volume, outside `/data/admin`), handled with
   git plumbing (temporary index, `commit-tree`, compare-and-swap `update-ref`, `merge-tree --write-tree`); no working
   tree, no shell-outs with user input in arguments. The control-plane image gets the `git` CLI. Branch `main` is the
   desired state. Layout: `gateway/{upstreams,allow-lists,limits}.yaml`, `safety/rules.yaml`, `agents/<id>.yaml`,
   `policies/liquid/**` (Rego, roles, `overlays.yaml`), `ontology/<domain>/*.yaml`, `playbooks/`, `OWNERS.yaml`.
2. **Bootstrap** is an extension step (`config-repo`): the first commit is the running platform (stores exported) plus
   the ontology and policies shipped in the image. Idempotent.
3. **No secrets in the repository.** Upstream credentials are exported only as Key Vault references; literal header
   values that look like credentials stay in `/data` and are merged back on apply. Agent files carry no secrets. Every
   commit is scanned for known secret values (agent secrets, extension secrets, gateway token) and refused if one is
   found.
4. **Console edits become commits** (commit-on-edit): after a successful change of upstreams, allow-lists, agents,
   safety rules or overlays, the stores are exported and committed to `main` with the signed-in admin as author and
   `Requested-By` / `Change-Id` trailers. Extension operations (which register owned upstreams) are captured the same
   way.
5. **Reconciler** every 60 s and after each merge: parse + validate `main` → apply the differences to the stores →
   record the applied revision. It also runs when the stores drifted from `main` (e.g. an emptied `/data/admin`),
   compared after schema parsing so ordering and defaults do not count. It never deletes agents (a console action) and
   pauses while an extension operation runs. The OPA bundle is built from the policies of the *applied* revision.
6. **Proposals** are branches `proposal/<id>` with title, reason, evidence and author (agent with requesting user and
   task, or person). They are validated when created: layout and schemas, secrets, ontology compile (+ structural IR
   diff for the review), `opa check` + `opa test` for policy changes (compiler service, pinned OPA). **Invalid proposals
   cannot be approved.** Approval needs a person who satisfies the owners of every touched path (`OWNERS.yaml` of
   `main`, last matching rule wins; ontology class `owner` annotations resolved through teams) and who is not the
   requester; the proposal is re-validated on top of the current `main` and merged with `Approved-By`. Conflicts are
   reported, not resolved automatically.
7. **Agents propose through the MCP upstream `config`**, served by the control plane (`config__read`,
   `config__propose_change`, `config__get_proposal`); access is controlled by the agent's allow-list as for every tool.
8. **Ontology editor E2/E3:** "Edit as draft" forks the ontology files of `main`; typed operations are applied with the
   `yaml` Document API (comments and order preserved), each change is compiled by the compiler service, the canvas is
   coloured by the IR diff; "Submit" creates a proposal. The review page shows the text diff and the diff graph.

## Consequences

- With an emptied `/data/admin` (repository and secrets intact) the gateway, safety rules, allow-lists and overlays come
  back from the repository on the first reconcile (verified). Agents missing from the registry would be re-created with
  new secrets.
- Approving an ontology change records it in `main` and validates it, but does not yet change the running ontology
  server: compatibility checks and live apply are M8 (E4).
- Two writers (console, reconciler) work on the same stores; both run through one serialised queue in the control
  plane, and the console capture is the only path that writes store files into the repository.
