import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Alert from '@mui/material/Alert';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime, formatDateTime } from '@cw/ui';
import { api, type WikiProposal } from '../api';

/* ------------------------------------------------------------------ line diff (pages are small) */

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'del', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

function Diff({ before, after }: { before: string | null; after: string }) {
  const lines = useMemo(() => lineDiff(before ?? '', after), [before, after]);
  return (
    <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12.5, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'pre-wrap', maxHeight: 340, overflow: 'auto' }}>
      {lines.map((l, k) => (
        <Box key={k} component="div" sx={{ bgcolor: l.kind === 'add' ? 'rgba(46,125,50,.15)' : l.kind === 'del' ? 'rgba(198,40,40,.15)' : undefined, color: l.kind === 'same' ? 'text.secondary' : 'text.primary' }}>
          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
          {l.text}
        </Box>
      ))}
    </Box>
  );
}

function Md({ children }: { children: string }) {
  return (
    <Box sx={{ typography: 'body2', '& h1': { typography: 'h5', mt: 0, mb: 1.5 }, '& h2': { typography: 'h6', mt: 2, mb: 1 }, '& h3': { typography: 'subtitle1', fontWeight: 600, mt: 2, mb: 1 }, '& p, & ul, & ol': { my: 1 }, '& code': { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5, bgcolor: 'action.hover', px: 0.5, borderRadius: 0.5 }, '& table': { borderCollapse: 'collapse' }, '& td, & th': { border: '1px solid', borderColor: 'divider', px: 1, py: 0.5 } }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {children}
      </ReactMarkdown>
    </Box>
  );
}

/* ------------------------------------------------------------------ proposals */

function ProposalCard({ p, onDone }: { p: WikiProposal; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.content);
  const decide = useMutation({ mutationFn: (d: 'approve' | 'reject') => api.decideWikiProposal(p.id, d, comment.trim() || undefined, d === 'approve' && editing && text !== p.content ? text : undefined), onSuccess: onDone });
  return (
    <Card sx={{ mb: 3 }}>
      <CardHeader
        title={
          <Stack direction="row" sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}>
            <Typography variant="subtitle1" sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
              {p.path}
            </Typography>
            <Chip size="small" label={p.current === null ? 'new page' : 'change'} color={p.current === null ? 'info' : 'default'} />
            <Chip size="small" variant="outlined" label={p.agent} />
          </Stack>
        }
        subheader={
          <>
            <RelativeTime iso={p.createdAt} />
            {p.task ? ` · task ${p.task}` : ''}
            {p.requestedBy ? ` · for ${p.requestedBy}` : ''}
          </>
        }
      />
      <CardContent sx={{ pt: 0 }}>
        <Typography variant="body2" sx={{ mb: 0.5 }}>
          <b>Why:</b> {p.reason}
        </Typography>
        {p.evidence && (
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            <b>Evidence:</b> {p.evidence}
          </Typography>
        )}
        {p.baseChanged && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            The page changed after this proposal was written. Check the diff against the current text.
          </Alert>
        )}
        {editing ? <TextField multiline fullWidth minRows={8} value={text} onChange={(e) => setText(e.target.value)} slotProps={{ htmlInput: { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 } } }} /> : <Diff before={p.current} after={p.content} />}
        <Button size="small" sx={{ mt: 1 }} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Show the diff' : 'Edit before approving'}
        </Button>
        <TextField fullWidth size="small" label="Comment for the agent (required to reject)" value={comment} onChange={(e) => setComment(e.target.value)} sx={{ mt: 2 }} />
        <ErrorAlert error={decide.error} />
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button variant="contained" color="success" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
            Approve and publish
          </Button>
          <Button variant="outlined" color="error" disabled={decide.isPending || !comment.trim()} onClick={() => decide.mutate('reject')}>
            Reject
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function Proposals() {
  const qc = useQueryClient();
  const pending = useQuery({ queryKey: ['wiki-proposals', 'pending'], queryFn: () => api.wikiProposals('pending'), refetchInterval: 10_000 });
  const all = useQuery({ queryKey: ['wiki-proposals', 'all'], queryFn: () => api.wikiProposals(), refetchInterval: 30_000 });
  const done = (all.data ?? []).filter((p) => p.status !== 'pending').slice(0, 15);
  const refresh = () => void Promise.all([qc.invalidateQueries({ queryKey: ['wiki-proposals'] }), qc.invalidateQueries({ queryKey: ['wiki-pages'] })]);
  return (
    <>
      <ErrorAlert error={pending.error} />
      {pending.isLoading ? <Loading /> : !pending.data?.length ? <EmptyState title="Nothing to review" text="Agents propose changes of the wiki after a task; they appear here. Nothing is published before you approve it." /> : pending.data.map((p) => <ProposalCard key={p.id} p={p} onDone={refresh} />)}
      {done.length > 0 && (
        <Card>
          <CardHeader title="Decided" subheader="Newest first. The agent reads your comment before it proposes again." />
          <List dense>
            {done.map((p) => (
              <ListItemButton key={p.id} disableRipple sx={{ cursor: 'default' }}>
                <ListItemText
                  primary={
                    <>
                      <Chip size="small" color={p.status === 'approved' ? 'success' : 'error'} label={p.status} sx={{ mr: 1 }} />
                      <span style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{p.path}</span> · {p.agent}
                      {p.edited ? ' · edited by the reviewer' : ''}
                    </>
                  }
                  secondary={`${p.decidedBy ?? ''} · ${p.decidedAt ? formatDateTime(p.decidedAt) : ''}${p.comment ? ` · “${p.comment}”` : ''}`}
                />
              </ListItemButton>
            ))}
          </List>
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ pages */

function NewPageDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (path: string) => void }) {
  const [path, setPath] = useState('protocols/');
  const [content, setContent] = useState('# Title\n\n');
  const save = useMutation({ mutationFn: () => api.saveWikiPage(path.trim(), content, 'Created in the admin console'), onSuccess: () => onCreated(path.trim()) });
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>New page</DialogTitle>
      <DialogContent>
        <TextField fullWidth autoFocus margin="dense" label="Path" helperText="Lower case, up to four folder levels, ends in .md, for example protocols/handoff-to-procurement.md" value={path} onChange={(e) => setPath(e.target.value)} />
        <TextField fullWidth margin="dense" multiline minRows={10} label="Text (Markdown)" value={content} onChange={(e) => setContent(e.target.value)} />
        <ErrorAlert error={save.error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate()}>
          Publish
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function Pages() {
  const qc = useQueryClient();
  const pages = useQuery({ queryKey: ['wiki-pages'], queryFn: api.wikiPages, refetchInterval: 30_000 });
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (pages.data?.length && (!selected || !pages.data.some((p) => p.path === selected))) setSelected(pages.data.find((p) => p.path === 'index.md')?.path ?? pages.data[0]!.path);
  }, [pages.data, selected]);
  const page = useQuery({ queryKey: ['wiki-page', selected], queryFn: () => api.wikiPage(selected!), enabled: !!selected });
  const save = useMutation({
    mutationFn: () => api.saveWikiPage(selected!, text, note.trim() || undefined),
    onSuccess: () => {
      setEditing(false);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['wiki-page'] });
      void qc.invalidateQueries({ queryKey: ['wiki-pages'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteWikiPage(selected!),
    onSuccess: () => {
      setSelected(undefined);
      void qc.invalidateQueries({ queryKey: ['wiki-pages'] });
    },
  });
  return (
    <>
      <ErrorAlert error={pages.error} />
      <NewPageDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          setSelected(p);
          void qc.invalidateQueries({ queryKey: ['wiki-pages'] });
        }}
      />
      {pages.isLoading ? (
        <Loading />
      ) : (
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 4 }}>
            <Card>
              <CardHeader title="Pages" action={<Button size="small" onClick={() => setCreating(true)}>New page</Button>} />
              {!pages.data?.length ? (
                <CardContent>
                  <Typography variant="body2" color="text.secondary">
                    The wiki is empty. Create the first page, for example the index.
                  </Typography>
                </CardContent>
              ) : (
                <List dense>
                  {pages.data.map((p) => (
                    <ListItemButton key={p.path} selected={p.path === selected} onClick={() => { setSelected(p.path); setEditing(false); }}>
                      <ListItemText primary={p.title} secondary={p.path} />
                      {p.pending > 0 && <Chip size="small" color="warning" label={`${p.pending} proposed`} />}
                    </ListItemButton>
                  ))}
                </List>
              )}
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 8 }}>
            {selected && (
              <Card>
                <ErrorAlert error={page.error} />
                {page.data && (
                  <>
                    <CardHeader
                      title={page.data.path}
                      subheader={`Last published by ${page.data.updatedBy} · ${formatDateTime(page.data.updatedAt)}${page.data.note ? ` · ${page.data.note}` : ''}`}
                      action={
                        <Stack direction="row" spacing={1}>
                          {!editing && (
                            <Button size="small" onClick={() => { setText(page.data!.content); setEditing(true); }}>
                              Edit
                            </Button>
                          )}
                          <Button size="small" color="error" disabled={remove.isPending} onClick={() => window.confirm(`Delete ${page.data!.path}?`) && remove.mutate()}>
                            Delete
                          </Button>
                        </Stack>
                      }
                    />
                    <CardContent sx={{ pt: 0 }}>
                      {editing ? (
                        <>
                          <TextField multiline fullWidth minRows={12} value={text} onChange={(e) => setText(e.target.value)} slotProps={{ htmlInput: { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 } } }} />
                          <TextField fullWidth size="small" label="What changed and why (shown in the history)" value={note} onChange={(e) => setNote(e.target.value)} sx={{ mt: 2 }} />
                          <ErrorAlert error={save.error} />
                          <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                            <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate()}>
                              Publish
                            </Button>
                            <Button onClick={() => setEditing(false)}>Cancel</Button>
                          </Stack>
                        </>
                      ) : (
                        <>
                          <Md>{page.data.content}</Md>
                          {page.data.history.length > 0 && (
                            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 2 }}>
                              History: {page.data.history.slice(0, 5).map((h) => `${h.by}, ${formatDateTime(h.at)}${h.note ? ` (${h.note.slice(0, 60)})` : ''}`).join(' · ')}
                            </Typography>
                          )}
                        </>
                      )}
                    </CardContent>
                  </>
                )}
              </Card>
            )}
          </Grid>
        </Grid>
      )}
    </>
  );
}

/** The central wiki: shared, slowly changing company knowledge. Agents propose, people decide (ADR-0035). */
export function WikiPage() {
  const [tab, setTab] = useState<'proposals' | 'pages'>('proposals');
  const pending = useQuery({ queryKey: ['wiki-proposals', 'pending'], queryFn: () => api.wikiProposals('pending'), refetchInterval: 10_000 });
  return (
    <>
      <PageHeader title="Company wiki" subtitle="Shared knowledge of all agents, governed by people: agents read it and propose changes, nothing is published before a person approves it." />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 3 }}>
        <Tab
          value="proposals"
          label={
            <Badge color="warning" badgeContent={pending.data?.length ?? 0} sx={{ '& .MuiBadge-badge': { right: -14 } }}>
              Proposals to review
            </Badge>
          }
        />
        <Tab value="pages" label="Pages" />
      </Tabs>
      {tab === 'proposals' ? <Proposals /> : <Pages />}
    </>
  );
}
