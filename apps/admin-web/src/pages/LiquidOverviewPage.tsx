import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { ErrorAlert, KeyValueList, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { api } from '../api';
import { Section, forView, useRoleView } from '../components/Sections';
import { tutorialStarted } from './LiquidTutorialPage';

/*
 * Liquid Enterprise (ADR-0038) overview: what is installed, the health of the control loop (ADR-0051), the lake.
 */

const DOT: Record<'ok' | 'warn' | 'fail', 'success' | 'warning' | 'error'> = {
  ok: 'success',
  warn: 'warning',
  fail: 'error',
};

/** Every part of the control loop with its status and what to do about it (ADR-0051). */
function HealthCard() {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['liquid-health'],
    queryFn: api.liquidHealth,
    refetchInterval: 10_000,
  });
  return (
    <Card variant="outlined">
      <CardHeader
        title="Control loop health"
        subheader={
          q.data ? (
            <>
              checked <RelativeTime iso={q.data.checkedAt} />
            </>
          ) : (
            'services, policy distribution, dispatcher, reconciler, Git host, decisions, tightening'
          )
        }
        action={q.data && <Chip size="small" color={DOT[q.data.status]} label={q.data.status} />}
      />
      <CardContent>
        <ErrorAlert error={q.error} title="Could not check the health" />
        {q.isLoading && <Loading />}
        {q.data && q.data.items.every((i) => i.status === 'ok') && (
          <Typography variant="body2" sx={{ mb: 1 }}>
            All {q.data.items.length} checks are ok.
          </Typography>
        )}
        <Stack spacing={1.25}>
          {(q.data?.items ?? [])
            .filter((i) => i.status !== 'ok')
            .map((i) => (
              <Stack key={i.id} direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                <Chip size="small" color={DOT[i.status]} label={i.status} sx={{ minWidth: 52 }} />
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {i.link ? (
                      <Box
                        component="span"
                        sx={{
                          cursor: 'pointer',
                          '&:hover': { textDecoration: 'underline' },
                        }}
                        onClick={() => navigate(i.link!)}
                      >
                        {i.label}
                      </Box>
                    ) : (
                      i.label
                    )}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                    {i.detail}
                    {i.status !== 'ok' && i.hint ? ` — ${i.hint}` : ''}
                  </Typography>
                </Stack>
              </Stack>
            ))}
        </Stack>
        {q.data && q.data.items.some((i) => i.status === 'ok') && (
          <Box sx={{ mt: 1.5 }}>
            <Section
              title={`${q.data.items.filter((i) => i.status === 'ok').length} checks ok`}
              summary={q.data.items
                .filter((i) => i.status === 'ok')
                .map((i) => i.label)
                .join(' · ')}
            >
              <Stack spacing={0.75}>
                {q.data.items
                  .filter((i) => i.status === 'ok')
                  .map((i) => (
                    <Typography key={i.id} variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                      <b>{i.label}</b> — {i.detail}
                    </Typography>
                  ))}
              </Stack>
            </Section>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

/** What waits for a Business Engineer: proposals to review, approvals, held processes, apps about to expire. */
function AttentionRow() {
  const navigate = useNavigate();
  const proposals = useQuery({
    queryKey: ['liquid-proposals'],
    queryFn: api.liquidProposals,
    refetchInterval: 10_000,
  });
  const processes = useQuery({
    queryKey: ['liquid-processes'],
    queryFn: api.liquidProcesses,
    refetchInterval: 10_000,
  });
  const apps = useQuery({
    queryKey: ['liquid-apps'],
    queryFn: api.liquidApps,
    refetchInterval: 30_000,
  });
  const tiles: Array<{
    label: string;
    value?: number;
    to: string;
    tone: 'warning' | 'info' | 'error';
  }> = [
    {
      label: 'Proposals to review',
      value: proposals.data?.filter((p) => p.status === 'pending' || p.status === 'conflict').length,
      to: '/liquid/proposals',
      tone: 'warning',
    },
    {
      label: 'Approvals waiting',
      value: processes.data?.running.filter((p) => p.type === 'ApprovalWorkflow' && p.approval).length,
      to: '/liquid/processes?tab=approvals',
      tone: 'warning',
    },
    {
      label: 'Held processes',
      value: processes.data?.held,
      to: '/liquid/processes?tab=running',
      tone: 'info',
    },
    {
      label: 'Apps expiring (14 days)',
      value: apps.data?.filter((a) => a.status === 'active' && Date.parse(a.expiresAt) - Date.now() < 14 * 86_400_000).length,
      to: '/liquid/apps',
      tone: 'error',
    },
  ];
  return (
    <Grid container spacing={2} sx={{ mb: 3 }}>
      {tiles.map((t) => (
        <Grid key={t.label} size={{ xs: 6, md: 3 }}>
          <Card
            variant="outlined"
            sx={{
              cursor: 'pointer',
              height: '100%',
              '&:hover': { borderColor: 'primary.main' },
            }}
            onClick={() => navigate(t.to)}
          >
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                {t.label}
              </Typography>
              <Typography variant="h4" color={t.value ? `${t.tone}.main` : 'text.primary'}>
                {t.value ?? '–'}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}

function LakeCard() {
  const lake = useQuery({
    queryKey: ['liquid-lake'],
    queryFn: api.liquidLake,
    refetchInterval: 15_000,
  });
  const d = lake.data;
  const raw = d ? Object.entries(d.counts).filter(([t]) => t !== 'events') : [];
  return (
    <Box>
      {lake.isLoading && <Loading />}
      <ErrorAlert error={lake.error} title="The ontology server does not answer" />
      {d && (
        <Stack spacing={2}>
          <KeyValueList
            items={[
              ['Events in the log', `${d.eventLog.count} (last seq ${d.eventLog.maxSeq})`],
              [
                'Flushed to the lake',
                <>
                  up to seq {d.hwm}
                  {d.eventLog.maxSeq > d.hwm && <Chip size="small" color="info" sx={{ ml: 1 }} label={`${d.eventLog.maxSeq - d.hwm} pending`} />}
                </>,
              ],
              [
                'Last flush',
                d.lastFlush ? (
                  <>
                    <RelativeTime iso={d.lastFlush.at} /> · {d.lastFlush.result.flushed} event(s)
                  </>
                ) : (
                  '—'
                ),
              ],
              ['Lake snapshots', String(d.snapshots)],
              ['Extracts', d.extracts.length ? d.extracts.map((e) => e.id).join(', ') : 'none (install with demo data to seed the sofa company)'],
            ]}
          />
          {raw.length > 0 && (
            <Table size="small">
              <TableBody>
                {raw.map(([t, n]) => (
                  <TableRow key={t}>
                    <TableCell sx={{ fontFamily: 'monospace', py: 0.5 }}>raw.{t}</TableCell>
                    <TableCell align="right" sx={{ py: 0.5 }}>
                      {n}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Stack>
      )}
    </Box>
  );
}

export function LiquidOverviewPage() {
  const navigate = useNavigate();
  const { view } = useRoleView();
  const ext = useQuery({
    queryKey: ['extension', 'liquid'],
    queryFn: () => api.extension('liquid'),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader
        overline="Liquid enterprise"
        title="Overview"
        subtitle="Business data in open formats, its meaning in a versioned ontology, rules as code"
        actions={<Button onClick={() => navigate('/extensions')}>Manage extension</Button>}
      />
      {ext.isLoading && <Loading />}
      <ErrorAlert error={ext.error} title="Could not load the extension status" />
      {ext.data && (
        <>
          {!ext.data.available && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              The extension is not fully available. Check its services on the Extensions page.
            </Alert>
          )}
          {ext.data.available && !tutorialStarted() && (
            <Alert severity="info" sx={{ mb: 2 }} action={<Button onClick={() => navigate('/liquid/tutorial')}>Start the tutorial</Button>}>
              New here? The tutorial walks you through the core values of Liquid Enterprise in seven short chapters, on the live platform.
            </Alert>
          )}
          {ext.data.available && forView(view, ['business']) && <AttentionRow />}
          {forView(view, ['it']) && (
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, md: 7 }}>
                <HealthCard />
              </Grid>
              <Grid size={{ xs: 12, md: 5 }}>
                <Stack spacing={1}>
                  <Section title="Installation" summary={`version ${ext.data.installedVersion ?? ext.data.version} · ${ext.data.services.filter((x) => x.state === 'running').length} of ${ext.data.services.length} services running`}>
                    <KeyValueList
                      items={[
                        ['Version', ext.data.installedVersion ?? ext.data.version],
                        ...(ext.data.installedAt
                          ? ([
                              [
                                'Installed',
                                <>
                                  <RelativeTime iso={ext.data.installedAt} /> by {ext.data.installedBy}
                                </>,
                              ],
                            ] as Array<[string, React.ReactNode]>)
                          : []),
                        [
                          'Services',
                          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                            {ext.data.services.map((s) => (
                              <Chip key={s.name} size="small" color={s.state === 'running' ? 'success' : 'warning'} label={s.name} />
                            ))}
                          </Stack>,
                        ],
                        ['Gateway upstreams', ext.data.upstreams.length ? ext.data.upstreams.join(', ') : '—'],
                        ['Documentation', <code>{ext.data.docs}</code>],
                      ]}
                    />
                  </Section>
                  {ext.data.available && (
                    <Section title="Event log and lake" summary="Postgres event log, flushed into DuckLake every minute">
                      <LakeCard />
                    </Section>
                  )}
                </Stack>
              </Grid>
            </Grid>
          )}
        </>
      )}
    </>
  );
}
