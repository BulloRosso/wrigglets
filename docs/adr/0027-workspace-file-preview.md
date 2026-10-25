# ADR-0027: Workspace file preview in the browser

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Users check what an agent produced (reports, tables, diagrams, scans) without downloading every file. The workspace
API is read-only and already serves files with a strict content type, `nosniff` and a restrictive CSP.

## Decision

- Preview is rendered **in the browser** by the shared `FilePreview` component. It is used on the *Workspace* page and
  in a dialog opened from a task's result files and from the conversation.

  | Format | Rendering |
  |---|---|
  | Markdown | `react-markdown` + GFM, raw HTML disabled; fenced ```` ```mermaid ```` blocks render as diagrams; *Preview / Source* toggle |
  | Mermaid (`.mmd`, `.mermaid`) | `mermaid` 12.1.0 with `securityLevel: 'strict'` (no HTML labels, no click handlers, sanitized SVG), light/dark theme |
  | PDF | the browser's PDF viewer in an iframe |
  | Text, code, JSON, YAML, log | monospace, wrapped |
  | CSV | table (first 500 rows) |
  | PNG, JPEG, GIF, WebP | image |
  | XLSX, XLSM, XLS, ODS | SheetJS 0.20.3: one tab per sheet, formatted values only (no formula evaluation), first 500 rows |

- **Lazy loading:** Mermaid and SheetJS are loaded with `import()` only when such a file is opened, so the main bundle
  stays small.
- **SheetJS source:** SheetJS is installed from the vendor's CDN tarball (`cdn.sheetjs.com/xlsx-0.20.3`). The `xlsx`
  package on the npm registry is outdated (0.18.5) and has known advisories.
- **Server side:** no conversion happens on the server; only MIME types are added (`.mmd`, `.mermaid`, `.markdown`,
  `.xlsx`, `.xls`, `.xlsm`, `.ods`). The 20 MB preview limit stays.

## Consequences

- No extra server load and no document conversion service. The original bytes are what the user sees.
- Excel files with macros are shown as data only; macros never run.
- Large spreadsheets are truncated in the preview; *Download* gives the full file.
