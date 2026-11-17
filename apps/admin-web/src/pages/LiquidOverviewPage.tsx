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

/*
 * Liquid Enterprise (ADR-0038) overview: what is installed, the health of the control loop (ADR-0051), the lake.
 */

const DOT: Record<'ok' | 'warn' | 'fail', 'success' | 'warning' | 'error'> = { ok: 'success', warn: 'warning', fail: 'error' };

/** Every part of the control loop with its status and what to do about it (ADR-0051). */
function HealthCard() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['liquid-health'], queryFn: api.liquidHealth, refetchInterval: 10_000 });
  return (
    <Card variant="outlined">
      <CardHeader title="Control loop health" subheader={q.data ? <>checked <RelativeTime iso={q.data.checkedAt} /></> : 'services, policy distribution, dispatcher, reconciler, Git host, decisions, tightening'} action={q.data && <Chip size="small" color={DOT[q.data.status]} label={q.data.status} />} />
      <CardContent>
        <ErrorAlert error={q.error} title="Could not check the health" />
        {q.isLoading && <Loading />}
        <Stack spacing={1.25}>
          {(q.data?.items ?? []).map((i) => (
            <Stack key={i.id} direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Chip size="small" color={DOT[i.status]} label={i.status} sx={{ minWidth: 52 }} />
              <Stack sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {i.link ? (
                    <Box component="span" sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }} onClick={() => navigate(i.link!)}>
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
      </CardContent>
    </Card>
  );
}

function LakeCard() {
  const lake = useQuery({ queryKey: ['liquid-lake'], queryFn: api.liquidLake, refetchInterval: 15_000 });
  const d = lake.data;
  const raw = d ? Object.entries(d.counts).filter(([t]) => t !== 'events') : [];
  return (
    <Card variant="outlined">
      <CardHeader title="Event log and lake" subheader="Postgres event log, flushed into DuckLake (Parquet) every minute" />
      <CardContent>
        {lake.isLoading && <Loading />}
        <ErrorAlert error={lake.error} title="The ontology server does not answer" />
        {d && (
          <Stack spacing={2}>
            <KeyValueList
              items={[
                ['Events in the log', `${d.eventLog.count} (last seq ${d.eventLog.maxSeq})`],
                ['Flushed to the lake', <>up to seq {d.hwm}{d.eventLog.maxSeq > d.hwm && <Chip size="small" color="info" sx={{ ml: 1 }} label={`${d.eventLog.maxSeq - d.hwm} pending`} />}</>],
                ['Last flush', d.lastFlush ? <><RelativeTime iso={d.lastFlush.at} /> · {d.lastFlush.result.flushed} event(s)</> : '—'],
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
                      <TableCell align="right" sx={{ py: 0.5 }}>{n}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export function LiquidOverviewPage() {
  const navigate = useNavigate();
  const ext = useQuery({ queryKey: ['extension', 'liquid'], queryFn: () => api.extension('liquid'), refetchInterval: 15_000 });
  return (
    <>
      <PageHeader
        overline="Liquid enterprise"
        title="Overview"
        subtitle="Business data in open formats, its meaning in a versioned ontology, rules as code — everything above that replaceable."
        actions={<Button onClick={() => navigate('/extensions')}>Manage extension</Button>}
      />
      {ext.isLoading && <Loading />}
      <ErrorAlert error={ext.error} title="Could not load the extension status" />
      {ext.data && (
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 5 }}>
            <Card variant="outlined">
              <CardHeader title="Installation" />
              <CardContent>
                {!ext.data.available && <Alert severity="warning" sx={{ mb: 2 }}>The extension is not fully available. Check its services on the Extensions page.</Alert>}
                <KeyValueList
                  items={[
                    ['Mode', ext.data.mode === 'overlay' ? 'compose overlay' : 'installed from the console'],
                    ['Version', ext.data.installedVersion ?? ext.data.version],
                    ...(ext.data.installedAt ? ([['Installed', <><RelativeTime iso={ext.data.installedAt} /> by {ext.data.installedBy}</>]] as Array<[string, React.ReactNode]>) : []),
                    ['Services', <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>{ext.data.services.map((s) => <Chip key={s.name} size="small" color={s.state === 'running' ? 'success' : 'warning'} label={s.name} />)}</Stack>],
                    ['Gateway upstreams', ext.data.upstreams.length ? ext.data.upstreams.join(', ') : '—'],
                    ['Documentation', <code>{ext.data.docs}</code>],
                  ]}
                />
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 7 }}>
            <HealthCard />
          </Grid>
          {ext.data.available && (
            <Grid size={{ xs: 12, md: 5 }}>
              <LakeCard />
            </Grid>
          )}
        </Grid>
      )}
    </>
  );
}
