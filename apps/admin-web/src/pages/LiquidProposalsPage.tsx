import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlined from '@mui/icons-material/ErrorOutlined';
import { EmptyState, ErrorAlert, KeyValueList, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { api, type ConfigProposal } from '../api';
import { CHANGE_COLOR } from '../components/ontology/ClassNode';
import { Canvas } from './LiquidOntologyPage';
import { ProcessStepper, Section, SectionTabs, forView, useRoleView } from '../components/Sections';

/*
 * Config repository and change proposals (ADR-0046): the desired state in Git, what the reconciler applied, and the
 * review queue. Agents propose through the MCP upstream "config", people through the ontology editor (E3); the owners of
 * the touched paths approve. Ontology changes are shown as a diff graph (added green, removed red, changed amber).
 */

const STATUS_COLOR = {
  pending: 'warning',
  approved: 'success',
  rejected: 'default',
  conflict: 'error',
} as const;

function DiffText({ diff }: { diff: string }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        bgcolor: 'action.hover',
        borderRadius: 1,
        overflowX: 'auto',
        fontSize: 12,
        lineHeight: 1.5,
        maxHeight: 520,
      }}
    >
      {diff.split('\n').map((l, i) => (
        <Box
          key={i}
          component="span"
          sx={{
            display: 'block',
            color: l.startsWith('+') && !l.startsWith('+++') ? 'success.main' : l.startsWith('-') && !l.startsWith('---') ? 'error.main' : l.startsWith('@@') ? 'info.main' : 'text.primary',
            fontWeight: l.startsWith('diff ') ? 700 : 400,
          }}
        >
          {l || ' '}
        </Box>
      ))}
    </Box>
  );
}

function OntologyDiff({ p }: { p: ConfigProposal }) {
  const ir = useQuery({
    queryKey: ['liquid-proposal-ir', p.id],
    queryFn: () => api.liquidProposalIr(p.id),
    staleTime: Infinity,
  });
  const d = p.irDiff!;
  return (
    <Card variant="outlined">
      <CardHeader title="Ontology changes" subheader={`${d.summary.added} added · ${d.summary.changed} changed · ${d.summary.removed} removed`} />
      <CardContent>
        <Stack spacing={0.5} sx={{ mb: 2 }}>
          {d.changes.map((c, i) => (
            <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip
                size="small"
                label={c.kind}
                sx={{
                  bgcolor: CHANGE_COLOR[c.kind],
                  color: 'common.white',
                  minWidth: 70,
                }}
              />
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {c.element} {c.path}
              </Typography>
              {c.fields && (
                <Typography variant="caption" color="text.secondary">
                  {c.fields.join(', ')}
                </Typography>
              )}
            </Stack>
          ))}
        </Stack>
        {ir.isLoading && <Loading />}
        {ir.data && (
          <ReactFlowProvider>
            <Canvas ir={ir.data} changes={d.classes} focus={Object.keys(d.classes)} height="560px" bare />
          </ReactFlowProvider>
        )}
      </CardContent>
    </Card>
  );
}

function Detail({ pid }: { pid: string }) {
  const q = useQuery({
    queryKey: ['liquid-proposal', pid],
    queryFn: () => api.liquidProposal(pid),
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} title="Could not load the proposal" />;
  const p = q.data;
  const open = p.status === 'pending' || p.status === 'conflict';
  // where the proposal stands in its lifecycle (UI review LIQ-07)
  let active = p.validation.ok ? 2 : 1;
  let failed: number | undefined = p.validation.ok ? undefined : 1;
  if (p.validation.ok && p.pr) active = 3;
  if (p.decidedBy || p.status === 'approved' || p.status === 'rejected') active = 4;
  if (p.status === 'rejected') failed = 3;
  if (p.status === 'conflict') failed = active;
  if (p.mergedAs) active = 5;
  const summary = (
    <Card variant="outlined">
      <CardHeader
        title={p.title}
        subheader={
          <>
            {p.author.kind === 'agent' ? `agent ${p.author.id}${p.author.user ? ` for ${p.author.user}` : ''}` : p.author.id} · <RelativeTime iso={p.createdAt} />
          </>
        }
        action={<Chip color={STATUS_COLOR[p.status]} label={p.status} />}
      />
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {p.reason}
          </Typography>
          {p.evidence && (
            <Section title="Evidence" summary="What the author attached to back the change">
              <Typography
                variant="caption"
                component="pre"
                sx={{
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'monospace',
                  color: 'text.secondary',
                  m: 0,
                }}
              >
                {p.evidence}
              </Typography>
            </Section>
          )}
          <KeyValueList
            items={[
              ['Files', <code>{p.paths.join(', ')}</code>],
              ...(p.compat
                ? ([
                    [
                      'Compatibility',
                      <>
                        <Chip size="small" color={p.compat.level === 'major' ? 'error' : p.compat.level === 'minor' ? 'primary' : 'default'} label={p.compat.level} /> {p.compat.findings.length} change(s), suggested version{' '}
                        {p.compat.suggestedVersion}
                      </>,
                    ],
                  ] as Array<[string, React.ReactNode]>)
                : []),
              ...(p.migrationNote ? ([['Migration note', p.migrationNote]] as Array<[string, React.ReactNode]>) : []),
              ['Approvers', p.owners.map((o) => `${o.owners.join(' or ')} (${o.for})`).join('; ') || '—'],
              ['Base', <code>{p.base.slice(0, 12)}</code>],
              ...(p.pr
                ? ([
                    [
                      'Pull request',
                      <a href={p.pr.url} target="_blank" rel="noreferrer">
                        #{p.pr.number}
                      </a>,
                    ],
                  ] as Array<[string, React.ReactNode]>)
                : []),
              ...(p.decidedBy
                ? ([
                    [
                      'Decided',
                      <>
                        {p.decidedBy} · <RelativeTime iso={p.decidedAt!} />
                        {p.comment ? ` · “${p.comment}”` : ''}
                      </>,
                    ],
                  ] as Array<[string, React.ReactNode]>)
                : []),
              ...(p.mergedAs ? ([['Merged as', <code>{p.mergedAs.slice(0, 12)}</code>]] as Array<[string, React.ReactNode]>) : []),
            ]}
          />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Validation
            </Typography>
            {p.validation.checks.map((c) => (
              <Box key={c.name} sx={{ mb: 0.5 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  {c.ok ? <CheckCircleOutlined color="success" fontSize="small" /> : <ErrorOutlined color="error" fontSize="small" />}
                  <Typography variant="body2">{c.name}</Typography>
                  {c.detail && (
                    <Typography variant="caption" color="text.secondary">
                      {c.detail}
                    </Typography>
                  )}
                </Stack>
                {c.errors?.map((e, i) => (
                  <Typography key={i} variant="caption" color="error" sx={{ display: 'block', pl: 4, fontFamily: 'monospace' }}>
                    {e.path}: {e.message}
                  </Typography>
                ))}
              </Box>
            ))}
          </Box>
          {open && p.pr && (
            <Alert
              severity="info"
              action={
                <Button size="small" href={p.pr.url} target="_blank" rel="noreferrer">
                  Review in Forgejo
                </Button>
              }
            >
              Pull request #{p.pr.number} on the Git host: reviewers approve and merge there (CODEOWNERS, branch protection, required check <code>liquid/validate</code> {p.validation.ok ? 'passed' : 'failed'}). The merge is applied within
              one reconcile.
            </Alert>
          )}
          {open && !p.pr && <Alert severity="warning">Waiting for the Git host: the pull request is opened as soon as it is reachable (see Overview → Control loop health).</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
  const hasOntology = !!p.irDiff && p.irDiff.changes.length > 0;
  return (
    <Box>
      <ProcessStepper steps={['Proposed', 'Validated', 'Pull request', 'Reviewed', 'Merged']} active={active} failed={failed} />
      <SectionTabs
        param="view"
        tabs={[
          { id: 'summary', label: 'Summary', render: () => summary },
          ...(hasOntology
            ? [
                {
                  id: 'ontology',
                  label: 'Ontology changes',
                  badge: p.irDiff!.changes.length,
                  render: () => <OntologyDiff p={p} />,
                },
              ]
            : []),
          {
            id: 'diff',
            label: 'Files',
            render: () => (
              <Card variant="outlined">
                <CardHeader title="Diff" subheader="against the main branch at the time of the proposal" />
                <CardContent>{p.diff ? <DiffText diff={p.diff} /> : <Typography variant="body2">No textual changes.</Typography>}</CardContent>
              </Card>
            ),
          },
        ]}
      />
    </Box>
  );
}

function RepoStatus() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['liquid-config'],
    queryFn: api.liquidConfig,
    refetchInterval: 10_000,
  });
  const reconcile = useMutation({
    mutationFn: api.reconcileLiquidConfig,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-config'] }),
  });
  const d = q.data;
  return (
    <Card variant="outlined">
      <CardHeader
        title="Config repository"
        subheader="Desired state in Git (main), applied by the reconciler"
        action={
          <Button size="small" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
            Reconcile now
          </Button>
        }
      />
      <CardContent>
        <ErrorAlert error={q.error ?? reconcile.error} title="Config repository" />
        {d && !d.initialized && <Alert severity="warning">Not initialised yet: run Repair on the Extensions page.</Alert>}
        {d?.initialized && (
          <Stack spacing={1.5}>
            <KeyValueList
              items={[
                ['main', <code>{d.head?.slice(0, 12)}</code>],
                ['Applied', <>{d.inSync ? <Chip size="small" color="success" label="in sync" /> : <Chip size="small" color="warning" label={`applied ${d.applied?.slice(0, 12) ?? '—'}`} />}</>],
                [
                  'Last reconcile',
                  d.lastReconcile ? (
                    <>
                      <RelativeTime iso={d.lastReconcile.at} /> · {d.lastReconcile.ok ? (d.lastReconcile.changes.length ? d.lastReconcile.changes.join('; ') : 'no changes') : 'failed'}
                    </>
                  ) : (
                    '—'
                  ),
                ],
                [
                  'Drift',
                  d.drift.length ? (
                    <Typography variant="caption" color="warning.main">
                      {d.drift.join(', ')}
                    </Typography>
                  ) : (
                    'none'
                  ),
                ],
              ]}
            />
            {d.lastReconcile &&
              !d.lastReconcile.ok &&
              d.lastReconcile.errors.map((e, i) => (
                <Alert key={i} severity="error">
                  {e.path}: {e.message}
                </Alert>
              ))}
            <Typography variant="subtitle2">Recent commits</Typography>
            {d.log.slice(0, 8).map((c) => (
              <Box key={c.commit}>
                <Typography variant="body2" noWrap>
                  <code>{c.commit.slice(0, 7)}</code> {c.subject}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {c.email} · <RelativeTime iso={c.at} />
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export function LiquidProposalsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['liquid-proposals'],
    queryFn: api.liquidProposals,
    refetchInterval: 5000,
  });
  const list = q.data ?? [];
  const current = id ?? list.find((p) => p.status === 'pending')?.id;
  const { view } = useRoleView();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const shown = list.filter((p) => filter === 'all' || p.status === 'pending' || p.status === 'conflict' || p.id === current);
  return (
    <>
      <PageHeader overline="Liquid enterprise" title="Proposals" subtitle="Changes proposed by agents and people; the owners of what they touch review them" />
      <ErrorAlert error={q.error} title="Could not load the proposals" />
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Stack spacing={2}>
            <Card variant="outlined">
              <CardHeader
                title="Proposals"
                action={
                  <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v: 'open' | 'all' | null) => v && setFilter(v)}>
                    <ToggleButton value="open">Open ({list.filter((p) => p.status === 'pending' || p.status === 'conflict').length})</ToggleButton>
                    <ToggleButton value="all">All ({list.length})</ToggleButton>
                  </ToggleButtonGroup>
                }
              />
              {shown.length === 0 ? (
                <CardContent>
                  <EmptyState title={filter === 'open' ? 'Nothing to review' : 'No proposals'} text="Agents propose with the config tools (config__propose_change); in the ontology editor, “Edit as draft” → Submit." />
                </CardContent>
              ) : (
                <List dense disablePadding>
                  {shown.map((p) => (
                    <ListItemButton key={p.id} selected={p.id === current} onClick={() => navigate(`/liquid/proposals/${p.id}`)}>
                      <ListItemText
                        primary={p.title}
                        secondary={
                          <>
                            {p.author.id} · <RelativeTime iso={p.createdAt} />
                          </>
                        }
                      />
                      <Chip size="small" color={STATUS_COLOR[p.status]} label={p.status} />
                    </ListItemButton>
                  ))}
                </List>
              )}
            </Card>
            {forView(view, ['it']) && (
              <Section title="Config repository" summary="main, applied revision, drift, recent commits">
                <RepoStatus />
              </Section>
            )}
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 8 }}>{current ? <Detail key={current} pid={current} /> : <EmptyState title="Select a proposal" text="Pending proposals appear first." />}</Grid>
      </Grid>
    </>
  );
}
