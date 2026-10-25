# ADR-0011: Material UI (MUI) for all user interfaces

- **Status:** Accepted
- **Date:** 2026-10-25
- **Spec:** §11 ("a component library of choice (e.g. Fluent UI React v9 …)")

## Decision

All three UIs — agent UI, admin console, sign-in pages — use **React 19 + MUI 9** with one shared theme and shared
components in `packages/ui` (AppShell, StatusChip, TimelineChart, Sparkline, dialogs, formatting helpers):

- light and dark colour schemes via CSS variables, user toggle (system/light/dark),
- one brand palette (primary `#1f5fad`, secondary teal), Roboto, rounded cards, outlined surfaces,
- responsive navigation drawer (permanent ≥ md, temporary below) for tablet widths (spec §11.2),
- the activity timeline is a custom SVG component (no chart dependency), as the spec suggests.

## Consequences

- Consistent look across all applications as requested; Fluent UI would match Microsoft 365 more closely and could
  be revisited if the UI is embedded into Teams later.
