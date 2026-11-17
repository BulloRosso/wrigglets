import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActions from '@mui/material/CardActions';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutline from '@mui/icons-material/ErrorOutlined';
import HourglassEmptyOutlined from '@mui/icons-material/HourglassEmptyOutlined';
import RadioButtonUnchecked from '@mui/icons-material/RadioButtonUnchecked';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import { ConfirmDialog, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import type { ExtensionStatus } from '../api';
import { api } from '../api';

/*
 * Optional extensions (ADR-0039). Liquid Enterprise is installed from here: the control plane creates its containers,
 * secrets and gateway upstreams. Signals (ADR-0037) still comes from a compose overlay and is shown read-only.
 */

const PHASE: Record<ExtensionStatus['phase'], { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info' }> = {
  not_installed: { label: 'not installed', color: 'default' },
  installing: { label: 'installing…', color: 'info' },
  installed: { label: 'installed', color: 'success' },
  failed: { label: 'failed', color: 'error' },
  uninstalling: { label: 'uninstalling…', color: 'info' },
};

const SERVICE_COLOR = { running: 'success', starting: 'info', unhealthy: 'error', stopped: 'warning', missing: 'default' } as const;

function StepIcon({ state }: { state: string }) {
  if (state === 'done') return <CheckCircleOutline fontSize="small" color="success" />;
  if (state === 'failed') return <ErrorOutline fontSize="small" color="error" />;
  if (state === 'running') return <SyncOutlined fontSize="small" color="info" />;
  if (state === 'skipped') return <RadioButtonUnchecked fontSize="small" color="disabled" />;
  return <HourglassEmptyOutlined fontSize="small" color="disabled" />;
}

function Operation({ ext }: { ext: ExtensionStatus }) {
  const op = ext.operation;
  if (!op) return null;
  const done = op.steps.filter((s) => s.state === 'done').length;
  const busy = !op.finishedAt;
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Last operation: {op.kind} by {op.by} · started <RelativeTime iso={op.startedAt} />
        {op.finishedAt && (
          <>
            {' '}
            · finished <RelativeTime iso={op.finishedAt} />
          </>
        )}
      </Typography>
      {busy && <LinearProgress variant="determinate" value={(done / Math.max(op.steps.length, 1)) * 100} sx={{ mb: 1 }} />}
      <Stack spacing={0.5}>
        {op.steps.map((s) => (
          <Stack key={s.id} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <StepIcon state={s.state} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2">{s.label}</Typography>
              {s.error && (
                <Typography variant="caption" color="error" sx={{ wordBreak: 'break-word' }}>
                  {s.error}
                </Typography>
              )}
            </Box>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function LogsDialog({ ext, service, onClose }: { ext: string; service?: string; onClose: () => void }) {
  const logs = useQuery({ queryKey: ['extension-logs', ext, service], queryFn: () => api.extensionLogs(ext, service!), enabled: !!service });
  return (
    <Dialog open={!!service} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>Logs · {service}</DialogTitle>
      <DialogContent>
        {logs.isLoading && <Loading />}
        <ErrorAlert error={logs.error} title="Could not load the logs" />
        {logs.data !== undefined && (
          <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {logs.data || '(no output)'}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void logs.refetch()}>Refresh</Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function ExtensionCard({ ext }: { ext: ExtensionStatus }) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'install' | 'uninstall' | 'repair' | undefined>();
  const [seedDemo, setSeedDemo] = useState(true);
  const [purgeData, setPurgeData] = useState(false);
  const [logsFor, setLogsFor] = useState<string | undefined>();
  const done = () => {
    setDialog(undefined);
    void qc.invalidateQueries({ queryKey: ['extensions'] });
  };
  const install = useMutation({ mutationFn: () => api.installExtension(ext.id, seedDemo), onSuccess: done });
  const uninstall = useMutation({ mutationFn: () => api.uninstallExtension(ext.id, purgeData), onSuccess: done });
  const repair = useMutation({ mutationFn: () => api.repairExtension(ext.id), onSuccess: done });

  const busy = ext.phase === 'installing' || ext.phase === 'uninstalling';
  const phase = PHASE[ext.phase];

  return (
    <Card variant="outlined">
      <CardHeader
        title={ext.name}
        subheader={`version ${ext.version}${ext.installedVersion && ext.installedVersion !== ext.version ? ` (installed: ${ext.installedVersion})` : ''}`}
        action={
          <Stack direction="row" spacing={1} sx={{ pt: 1, pr: 1 }}>
            <Chip size="small" color={phase.color} label={phase.label} />
            {ext.phase === 'installed' && <Chip size="small" color={ext.available ? 'success' : 'warning'} variant="outlined" label={ext.available ? 'available' : 'degraded'} />}
          </Stack>
        }
      />
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {ext.description}
          </Typography>
          {ext.docs && (
            <Typography variant="caption" color="text.secondary">
              Documentation: <code>{ext.docs}</code>
            </Typography>
          )}
          {ext.installedAt && (
            <Typography variant="caption" color="text.secondary">
              Installed <RelativeTime iso={ext.installedAt} /> by {ext.installedBy}
            </Typography>
          )}
          {ext.blockedReason && ext.phase !== 'installed' && <Alert severity="warning">{ext.blockedReason}</Alert>}
          {ext.phase === 'installed' && !ext.available && <Alert severity="warning">Not every service is running. Its pages are hidden until it is healthy again; “Repair” re-creates missing or changed containers.</Alert>}

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Service</TableCell>
                <TableCell>Image</TableCell>
                <TableCell>State</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {ext.services.map((s) => (
                <TableRow key={s.name}>
                  <TableCell>
                    <Typography variant="body2">{s.name}</Typography>
                    {s.description && (
                      <Typography variant="caption" color="text.secondary">
                        {s.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                      {s.image}
                    </Typography>
                    {s.imagePresent === false && <Chip size="small" color={s.local ? 'warning' : 'default'} variant="outlined" label={s.local ? 'not built' : 'will be pulled'} sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" color={SERVICE_COLOR[s.state]} label={s.state} title={s.detail} />
                  </TableCell>
                  <TableCell align="right">
                    {s.state !== 'missing' && (
                      <Button size="small" onClick={() => setLogsFor(s.name)}>
                        Logs
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {ext.upstreams.length > 0 && (
            <Typography variant="body2">
              Gateway upstreams owned by this extension: {ext.upstreams.map((u) => <Chip key={u} size="small" label={u} sx={{ mr: 0.5 }} />)}
            </Typography>
          )}
          <Operation ext={ext} />
        </Stack>
      </CardContent>
      <CardActions sx={{ px: 2, pb: 2 }}>
        {(ext.phase === 'not_installed' || ext.phase === 'failed') && (
          <Button variant="contained" disabled={busy || ext.missingImages.length > 0} onClick={() => setDialog('install')}>
            {ext.phase === 'failed' && ext.operation?.kind !== 'uninstall' ? 'Retry install' : 'Install'}
          </Button>
        )}
        {(ext.phase === 'installed' || ext.phase === 'failed') && (
          <Button disabled={busy} onClick={() => setDialog('repair')}>
            Repair
          </Button>
        )}
        {(ext.phase === 'installed' || ext.phase === 'failed') && (
          <Button color="error" disabled={busy} onClick={() => setDialog('uninstall')}>
            Uninstall
          </Button>
        )}
        </CardActions>

      <ConfirmDialog
        open={dialog === 'install'}
        title={`Install ${ext.name}`}
        text={`The control plane creates ${ext.services.length} container(s), generates their secrets${ext.upstreams.length ? ' and registers its gateway upstreams' : ''}. You can follow every step here.`}
        confirmLabel="Install"
        busy={install.isPending}
        error={install.error}
        onConfirm={() => install.mutate()}
        onClose={() => setDialog(undefined)}
      >
        <FormControlLabel control={<Checkbox checked={seedDemo} onChange={(e) => setSeedDemo(e.target.checked)} />} label="Seed the sofa-company demo data" sx={{ mt: 1 }} />
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'repair'}
        title={`Repair ${ext.name}`}
        text="Runs every install step again: re-creates missing or changed containers, starts stopped ones and re-registers the gateway upstreams. Data and secrets are kept."
        confirmLabel="Repair"
        busy={repair.isPending}
        error={repair.error}
        onConfirm={() => repair.mutate()}
        onClose={() => setDialog(undefined)}
      />
      <ConfirmDialog
        open={dialog === 'uninstall'}
        title={`Uninstall ${ext.name}`}
        text="Removes its containers and the gateway upstreams it registered. Agents lose the tools of these upstreams immediately."
        confirmLabel={purgeData ? 'Uninstall and delete data' : 'Uninstall'}
        confirmColor="error"
        busy={uninstall.isPending}
        error={uninstall.error}
        onConfirm={() => uninstall.mutate()}
        onClose={() => setDialog(undefined)}
      >
        <FormControlLabel control={<Checkbox checked={purgeData} onChange={(e) => setPurgeData(e.target.checked)} />} label="Also delete its data volumes and secrets (cannot be undone)" sx={{ mt: 1 }} />
      </ConfirmDialog>
      <LogsDialog ext={ext.id} service={logsFor} onClose={() => setLogsFor(undefined)} />
    </Card>
  );
}

function SignalsCard() {
  const signals = useQuery({ queryKey: ['signals-available'], queryFn: api.signalsAvailable, staleTime: 60_000 });
  return (
    <Card variant="outlined">
      <CardHeader
        title="Signals"
        subheader="ADR-0037"
        action={
          <Stack direction="row" spacing={1} sx={{ pt: 1, pr: 1 }}>
            <Chip size="small" variant="outlined" label="compose overlay" />
            <Chip size="small" color={signals.data?.available ? 'success' : 'default'} label={signals.data?.available ? 'on' : 'off'} />
          </Stack>
        }
      />
      <CardContent>
        <Typography variant="body2" color="text.secondary">
          Proactive follow-up on observations and deadlines. Managed by the overlay <code>docker-compose.signals.yml</code>, not from here; see <code>docs/signals.md</code>.
        </Typography>
      </CardContent>
    </Card>
  );
}

export function ExtensionsPage() {
  const list = useQuery({
    queryKey: ['extensions'],
    queryFn: api.extensions,
    refetchInterval: (q) => (q.state.data?.some((e) => e.phase === 'installing' || e.phase === 'uninstalling') ? 1500 : 15_000),
  });
  return (
    <>
      <PageHeader title="Extensions" subtitle="Optional modules of the platform. Installing one starts its services; uninstalling removes everything it registered." />
      {list.isLoading && <Loading />}
      <ErrorAlert error={list.error} title="Could not load the extensions" />
      <Stack spacing={3}>
        {list.data?.map((e) => <ExtensionCard key={e.id} ext={e} />)}
        <SignalsCard />
      </Stack>
    </>
  );
}
