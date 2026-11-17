import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ConfirmDialog, EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { directionOf, type Playbook } from '@cw/playbooks';
import { SectionTabs } from '../components/Sections';
import { api, type PlaybookRunView, type PlaybookStepResult } from '../api';

/*
 * Playbooks and the control loop (ADR-0047): the playbooks of the config repository, their runs as a timeline of steps,
 * and the decisions waiting for a person. Tightening steps run automatically; loosening steps (restore) wait here.
 */

const DIR_COLOR = {
  tighten: 'warning',
  neutral: 'default',
  loosen: 'success',
} as const;
const STATE_COLOR: Record<PlaybookStepResult['state'], 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  pending: 'default',
  awaiting_approval: 'warning',
  running: 'info',
  done: 'success',
  failed: 'error',
  skipped: 'default',
  proposed: 'info',
  cancelled: 'default',
};
const RUN_COLOR = {
  running: 'info',
  awaiting_approval: 'warning',
  completed: 'success',
  cancelled: 'default',
  failed: 'error',
} as const;

function PlaybookCard({ p, source }: { p: Playbook; source?: string }) {
  return (
    <Card variant="outlined">
      <CardHeader
        title={p.title ?? p.id}
        subheader={
          <>
            <code>{p.id}</code> v{p.version} · {source}
          </>
        }
      />
      <CardContent>
        <Stack spacing={1}>
          {p.description && <Typography variant="body2">{p.description}</Typography>}
          <Typography variant="caption" color="text.secondary">
            Trigger: <code>{p.trigger.kind}</code> {'match' in p.trigger ? <code>{JSON.stringify(p.trigger.match)}</code> : 'every' in p.trigger ? `every ${p.trigger.every}` : ''} · blast radius: {p.assess.blast_radius}
          </Typography>
          {p.steps.map((s, i) => {
            const dir = directionOf(s.type) ?? 'neutral';
            return (
              <Stack key={s.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="caption" sx={{ width: 18, color: 'text.secondary' }}>
                  {i + 1}
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: 1, minWidth: 0 }} noWrap>
                  {s.id} <span style={{ opacity: 0.6 }}>{s.type}</span>
                </Typography>
                <Chip size="small" variant="outlined" color={DIR_COLOR[dir]} label={dir} />
                <Chip size="small" label={s.autonomy} color={s.autonomy === 'human' ? 'secondary' : 'default'} />
              </Stack>
            );
          })}
        </Stack>
      </CardContent>
    </Card>
  );
}

function RunCard({ r }: { r: PlaybookRunView }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['liquid-playbook-runs'] });
  const decide = useMutation({
    mutationFn: (v: { step: string; decision: 'approve' | 'reject' }) => api.decidePlaybookStep(r.runId, v.step, v.decision, comment || undefined),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelPlaybookRun(r.runId),
    onSuccess: refresh,
  });
  const waiting = r.steps.find((s) => s.state === 'awaiting_approval');
  const open = r.state === 'running' || r.state === 'awaiting_approval';
  return (
    <Card variant="outlined">
      <CardHeader
        title={
          <>
            {r.playbook}{' '}
            <Typography component="span" variant="caption" color="text.secondary">
              {r.runId}
            </Typography>
          </>
        }
        subheader={
          <>
            trigger {r.trigger.kind}:{' '}
            {Object.entries(r.trigger.data)
              .filter(([k]) => ['source', 'severity', 'upstream', 'summary', 'rule', 'agent'].includes(k))
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(' · ')}{' '}
            · <RelativeTime iso={r.startTime} />
          </>
        }
        action={<Chip color={RUN_COLOR[r.state]} label={r.state.replace('_', ' ')} />}
      />
      <CardContent>
        <Stack spacing={1.5}>
          {r.blast && (
            <Typography variant="caption" color="text.secondary">
              Blast radius of <b>{r.blast.upstream}</b>: {r.blast.tools.length} tools · {r.blast.writeActions.length} write actions · classes {r.blast.classes.join(', ') || '—'} · {r.blast.workflows.length} running workflow(s)
            </Typography>
          )}
          <Box sx={{ borderLeft: 2, borderColor: 'divider', pl: 2 }}>
            {r.steps.map((s) => (
              <Box key={s.id} sx={{ mb: 1 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Chip size="small" color={STATE_COLOR[s.state]} label={s.state.replace('_', ' ')} sx={{ minWidth: 92 }} />
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {s.id}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {s.type} · {s.autonomy}
                  </Typography>
                </Stack>
                {(s.summary || s.error) && (
                  <Typography variant="caption" sx={{ display: 'block', pl: 1, mt: 0.25 }} color={s.state === 'failed' ? 'error' : 'text.secondary'}>
                    {s.error ?? s.summary}
                    {s.approvedBy ? ` · approved by ${s.approvedBy}` : s.decidedBy ? ` · decided by ${s.decidedBy}` : ''}
                  </Typography>
                )}
              </Box>
            ))}
          </Box>
          {waiting && open && (
            <Alert severity="warning">
              <Stack spacing={1}>
                <Typography variant="body2">
                  <b>{waiting.id}</b> ({waiting.type}) loosens what this run tightened. It runs only when a person approves.
                </Typography>
                <TextField size="small" label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} />
                <ErrorAlert error={decide.error} title="Decision refused" />
                <Stack direction="row" spacing={1}>
                  <Button variant="contained" size="small" disabled={decide.isPending} onClick={() => decide.mutate({ step: waiting.id, decision: 'approve' })}>
                    Approve {waiting.id}
                  </Button>
                  <Button size="small" disabled={decide.isPending} onClick={() => decide.mutate({ step: waiting.id, decision: 'reject' })}>
                    Reject
                  </Button>
                </Stack>
              </Stack>
            </Alert>
          )}
          {open && (
            <Box>
              <Button size="small" color="error" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel run (nothing is loosened)
              </Button>
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

function AlertDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [a, setA] = useState({
    source: 'vuln-feed',
    severity: 'critical',
    upstream: 'erp',
    summary: 'CVE-2026-0001 in the ERP connector',
  });
  const send = useMutation({
    mutationFn: () => api.sendPlaybookAlert(a),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['liquid-playbook-runs'] });
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open={open}
      title="Send a test alert"
      text="The alert goes the same way as an external one (POST /internal/alerts): it is recorded as an event and starts every matching playbook. Tightening steps take effect immediately."
      confirmLabel="Send alert"
      busy={send.isPending}
      error={send.error}
      onConfirm={() => send.mutate()}
      onClose={onClose}
    >
      <Stack spacing={2} sx={{ mt: 1 }}>
        <TextField label="Source" value={a.source} onChange={(e) => setA({ ...a, source: e.target.value })} />
        <TextField select label="Severity" value={a.severity} onChange={(e) => setA({ ...a, severity: e.target.value })}>
          {['low', 'medium', 'high', 'critical'].map((x) => (
            <MenuItem key={x} value={x}>
              {x}
            </MenuItem>
          ))}
        </TextField>
        <TextField label="Upstream" value={a.upstream} onChange={(e) => setA({ ...a, upstream: e.target.value })} />
        <TextField label="Summary" value={a.summary} onChange={(e) => setA({ ...a, summary: e.target.value })} />
      </Stack>
    </ConfirmDialog>
  );
}

export function LiquidPlaybooksPage() {
  const pbs = useQuery({
    queryKey: ['liquid-playbooks'],
    queryFn: api.liquidPlaybooks,
    refetchInterval: 30_000,
  });
  const runs = useQuery({
    queryKey: ['liquid-playbook-runs'],
    queryFn: api.liquidPlaybookRuns,
    refetchInterval: 3000,
  });
  const [alerting, setAlerting] = useState(false);
  const active = (runs.data ?? []).filter((r) => r.state === 'running' || r.state === 'awaiting_approval');
  const done = (runs.data ?? []).filter((r) => !active.includes(r)).slice(0, 10);
  return (
    <>
      <PageHeader
        overline="Liquid enterprise"
        title="Playbooks"
        subtitle="Sense → decide → act: tighten automatically, loosen only with a person"
        actions={
          <Button variant="contained" onClick={() => setAlerting(true)}>
            Send test alert
          </Button>
        }
      />
      <ErrorAlert error={pbs.error ?? runs.error} title="Could not load the playbooks" />
      {(pbs.isLoading || runs.isLoading) && <Loading />}
      {/* runs and definitions were two columns of cards; now tabs, active runs first (UI review LIQ-08) */}
      <SectionTabs
        tabs={[
          {
            id: 'active',
            label: 'Active runs',
            badge: active.length,
            badgeColor: 'warning',
            render: () => (
              <Stack spacing={2}>{active.length === 0 ? <EmptyState title="No active runs" text="An alert, a tripped safety rule or a schedule starts the matching playbooks." /> : active.map((r) => <RunCard key={r.runId} r={r} />)}</Stack>
            ),
          },
          {
            id: 'recent',
            label: 'Recent runs',
            render: () => <Stack spacing={2}>{done.length === 0 ? <EmptyState title="No finished runs" text="Finished, cancelled and failed runs show up here." /> : done.map((r) => <RunCard key={r.runId} r={r} />)}</Stack>,
          },
          {
            id: 'definitions',
            label: 'Playbooks',
            badge: pbs.data?.invalid.length ? `${pbs.data.invalid.length} invalid` : undefined,
            badgeColor: 'error',
            render: () => (
              <Stack spacing={2}>
                {pbs.data?.invalid.map((i) => (
                  <Alert key={i.path} severity="error">
                    {i.path}: {i.issues.map((x) => `${x.path}: ${x.message}`).join('; ')}
                  </Alert>
                ))}
                <Grid container spacing={2}>
                  {pbs.data?.playbooks.map((p) => (
                    <Grid key={p.id} size={{ xs: 12, lg: 6 }}>
                      <PlaybookCard p={p} source={pbs.data?.sources[p.id]} />
                    </Grid>
                  ))}
                </Grid>
              </Stack>
            ),
          },
        ]}
      />
      <AlertDialog open={alerting} onClose={() => setAlerting(false)} />
    </>
  );
}
