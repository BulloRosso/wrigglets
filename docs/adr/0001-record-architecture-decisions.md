# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

The implementation specification asks to record every ambiguity, deviation and choice in `docs/decisions.md`
(spec §0) "ADR style". The system will move from Docker Desktop to Microsoft Azure later; the people doing that
need to know *why* things are the way they are.

## Decision

We keep one Markdown file per decision in `docs/adr/`, numbered sequentially, with the sections
**Context**, **Decision**, **Consequences** (and **Alternatives** where useful). `docs/decisions.md` points here.
An ADR is never rewritten after acceptance; a later ADR supersedes it and the status is updated to
`Superseded by ADR-xxxx`.

## Consequences

- Decisions are reviewable in pull requests together with the code that implements them.
- Spec deviations are easy to find (each one links back to the spec section it touches).
