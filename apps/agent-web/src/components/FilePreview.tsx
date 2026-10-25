import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import { EmptyState, ErrorAlert, Loading } from '@cw/ui';
import { api } from '../api';
import { Markdown } from './Markdown';
import { MermaidDiagram } from './Mermaid';

/*
 * File preview for the workspace (read-only): Markdown (incl. Mermaid code blocks), Mermaid diagrams, PDF, plain
 * text and code, CSV, PNG/JPEG/GIF/WebP, Excel (XLSX/XLS). Heavy renderers (Mermaid, SheetJS) are loaded on demand.
 */

const TEXT_EXT = ['md', 'markdown', 'txt', 'csv', 'json', 'yaml', 'yml', 'py', 'ts', 'js', 'html', 'svg', 'xml', 'log', 'gitignore', 'mmd', 'mermaid'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const SHEET_EXT = ['xlsx', 'xls', 'xlsm', 'ods'];
const MAX_ROWS = 500;

export const extOf = (path: string) => (path.includes('.') ? (path.split('.').pop()?.toLowerCase() ?? '') : '');

export type PreviewKind = 'markdown' | 'mermaid' | 'pdf' | 'image' | 'sheet' | 'csv' | 'text' | 'none';

export function previewKind(path: string): PreviewKind {
  const ext = extOf(path);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (SHEET_EXT.includes(ext)) return 'sheet';
  if (ext === 'csv') return 'csv';
  if (TEXT_EXT.includes(ext) || !ext) return 'text';
  return 'none';
}

const KIND_LABEL: Record<PreviewKind, string> = {
  markdown: 'Markdown',
  mermaid: 'Mermaid diagram',
  pdf: 'PDF',
  image: 'Image',
  sheet: 'Spreadsheet',
  csv: 'CSV',
  text: 'Text',
  none: 'File',
};
export const previewLabel = (path: string) => KIND_LABEL[previewKind(path)];

/* ------------------------------------------------------------------ Tables (CSV, spreadsheets) */

function DataTable({ rows, truncated }: { rows: string[][]; truncated?: boolean }) {
  if (rows.length === 0) return <EmptyState title="Empty sheet" />;
  return (
    <Box sx={{ overflow: 'auto', maxHeight: '70vh' }}>
      <Box
        component="table"
        sx={{
          borderCollapse: 'collapse',
          fontSize: 13,
          '& td, & th': { border: 1, borderColor: 'divider', px: 1, py: 0.5, whiteSpace: 'nowrap' },
          '& th': { bgcolor: 'action.hover', position: 'sticky', top: 0 },
        }}
      >
        <thead>
          <tr>
            {rows[0]!.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </Box>
      {truncated && (
        <Typography variant="caption" color="text.secondary">
          First {MAX_ROWS} rows shown.
        </Typography>
      )}
    </Box>
  );
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const first = text.split('\n')[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < text.length && rows.length < MAX_ROWS + 1; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

interface Sheet {
  name: string;
  rows: string[][];
  truncated: boolean;
}

async function loadSheets(path: string): Promise<Sheet[]> {
  const res = await fetch(api.fileUrl(path), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 413 ? 'File too large for preview' : `Could not load file (${res.status})`);
  const XLSX = await import('xlsx');
  // No formula evaluation, no external links: values as formatted text only.
  const wb = XLSX.read(await res.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false, sheetRows: MAX_ROWS + 1 });
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: false, defval: '', blankrows: false });
    const width = Math.max(0, ...rows.map((r) => r.length));
    return {
      name,
      rows: rows.slice(0, MAX_ROWS + 1).map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? ''))),
      truncated: rows.length > MAX_ROWS,
    };
  });
}

function SheetPreview({ path }: { path: string }) {
  const q = useQuery({ queryKey: ['sheet', path], queryFn: () => loadSheets(path), staleTime: 60_000 });
  const [tab, setTab] = useState(0);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const sheets = q.data ?? [];
  const s = sheets[Math.min(tab, sheets.length - 1)];
  return (
    <>
      {sheets.length > 1 && (
        <Tabs value={Math.min(tab, sheets.length - 1)} onChange={(_, v: number) => setTab(v)} variant="scrollable" sx={{ mb: 1, minHeight: 36, '& .MuiTab-root': { minHeight: 36 } }}>
          {sheets.map((x, i) => (
            <Tab key={x.name} value={i} label={x.name} />
          ))}
        </Tabs>
      )}
      {s ? <DataTable rows={s.rows} truncated={s.truncated} /> : <EmptyState title="No sheets" />}
    </>
  );
}

/* ------------------------------------------------------------------ Preview */

const Pre = ({ text }: { text: string }) => (
  <Box component="pre" sx={{ m: 0, fontSize: 13, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '70vh', overflow: 'auto' }}>
    {text}
  </Box>
);

export function FilePreview({ path }: { path: string }) {
  const kind = previewKind(path);
  const textual = kind === 'markdown' || kind === 'mermaid' || kind === 'csv' || kind === 'text';
  const text = useQuery({ queryKey: ['file', path], queryFn: () => api.fileText(path), enabled: textual });
  const csv = useMemo(() => (kind === 'csv' && text.data ? parseCsv(text.data) : undefined), [kind, text.data]);
  const [view, setView] = useState<'rendered' | 'source'>('rendered');

  if (kind === 'image') return <Box component="img" src={api.fileUrl(path)} alt={path} sx={{ maxWidth: '100%', borderRadius: 1, display: 'block' }} />;
  if (kind === 'pdf') return <Box component="iframe" title={path} src={api.fileUrl(path)} sx={{ width: '100%', height: '75vh', border: 0, borderRadius: 1 }} />;
  if (kind === 'sheet') return <SheetPreview path={path} />;
  if (kind === 'none') {
    return (
      <EmptyState
        title="No preview available"
        text="Download the file to open it."
        action={
          <Button startIcon={<DownloadOutlined />} href={api.fileUrl(path, true)}>
            Download
          </Button>
        }
      />
    );
  }
  if (text.isLoading) return <Loading />;
  if (text.error) return <ErrorAlert error={text.error} />;
  const source = text.data ?? '';
  if (kind === 'csv' && csv) return <DataTable rows={csv} truncated={csv.length > MAX_ROWS} />;
  if (kind === 'text') return <Pre text={source} />;
  return (
    <>
      <Stack direction="row" sx={{ justifyContent: 'flex-end', mb: 1 }}>
        <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v: 'rendered' | 'source' | null) => v && setView(v)}>
          <ToggleButton value="rendered">Preview</ToggleButton>
          <ToggleButton value="source">Source</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {view === 'source' ? <Pre text={source} /> : kind === 'mermaid' ? <MermaidDiagram code={source} /> : <Markdown>{source}</Markdown>}
    </>
  );
}

/** Full-screen-ish preview dialog, e.g. for the outputs of a task. */
export function FilePreviewDialog({ path, onClose }: { path: string | undefined; onClose: () => void }) {
  return (
    <Dialog open={!!path} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle sx={{ pb: 1 }}>
        {path?.split('/').pop()}
        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {path} · {path ? previewLabel(path) : ''}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>{path && <FilePreview path={path} />}</DialogContent>
      <DialogActions>
        {path && (
          <Button startIcon={<DownloadOutlined />} href={api.fileUrl(path, true)}>
            Download
          </Button>
        )}
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
