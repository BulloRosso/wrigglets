import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
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
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ConfirmDialog, EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { api, type LiquidProcess } from '../api';

/*
 * Business processes (ADR-0045): the holdable workflows of namespace `business`. Holding by ontology object (e.g.
 * Supplier:S-NORDHOLZ) pauses exactly the workflows that touch it; releasing resumes them. Pending four-eyes approvals
 * are decided here by the signed-in person (who cannot be the requester).
 */

const STATE_COLOR: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  held: 'warning',
  awaiting_release: 'info',
  awaiting_delivery: 'info',
  pending: 'warning',
  reminded: 'warning',
  received: 'success',
  executed: 'success',
  late: 'error',
  cancelled: 'default',
  rejected: 'default',
  expired: 'default',
  execution_failed: 'error',
};

function Objects({ objects }: { objects: string[] }) {
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {objects.map((o) => (
        <Chip key={o} size="small" variant="outlined" label={o} sx={{ fontFamily: 'monospace', fontSize: 11 }} />
      ))}
    </Stack>
  );
}

function HoldDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [objects, setObjects] = useState('Supplier:S-NORDHOLZ');
  const [reason, setReason] = useState('');
  const hold = useMutation({
    mutationFn: () => api.holdLiquidProcesses(objects.split(',').map((x) => x.trim()).filter(Boolean), reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['liquid-processes'] });
      onClose();
    },
  });
  return (
    <ConfirmDialog open={open} title="Hold processes by object" text="Every running workflow that touches one of these objects pauses at its next step. Holding is tightening; it never runs or skips a step." confirmLabel="Hold" busy={hold.isPending} error={hold.error} onConfirm={() => hold.mutate()} onClose={onClose}>
      <Stack spacing={2} sx={{ mt: 1 }}>
        <TextField label="Objects (Class:id, comma-separated)" value={objects} onChange={(e) => setObjects(e.target.value)} />
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Supplier under review after a delivery incident" />
      </Stack>
    </ConfirmDialog>
  );
}

function ApprovalCard({ p }: { p: LiquidProcess }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'reject') => api.decideLiquidApproval(p.workflowId, d, comment || undefined),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-processes'] }),
  });
  const a = p.approval!;
  return (
    <Card variant="outlined">
      <CardHeader title={<code>{a.request.action}</code>} subheader={<>requested by {a.request.caller.agent ?? '—'}{a.request.caller.user ? ` for ${a.request.caller.user}` : ''} · <RelativeTime iso={p.startTime} /></>} action={<Chip size="small" color={STATE_COLOR[a.state] ?? 'default'} label={a.state} />} />
      <CardContent>
        <Stack spacing={1.5}>
          {a.request.reason && a.request.reason !== 'allowed' && <Typography variant="body2">{a.request.reason}</Typography>}
          <Typography component="pre" variant="caption" sx={{ fontFamily: 'monospace', m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }}>
            {JSON.stringify(a.request.args, null, 2)}
          </Typography>
          <Objects objects={a.request.objects} />
          <TextField size="small" label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <ErrorAlert error={decide.error} title="Decision refused" />
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              Approve and run
            </Button>
            <Button color="error" disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
              Reject
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

function ProcessTable({ rows, recent }: { rows: LiquidProcess[]; recent?: boolean }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Workflow</TableCell>
          <TableCell>State</TableCell>
          <TableCell>Objects</TableCell>
          <TableCell>{recent ? 'Closed' : 'Started'}</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((p) => {
          const state = p.hold?.held ? 'held' : (p.hold?.state ?? p.state ?? p.status.toLowerCase());
          return (
            <TableRow key={p.workflowId}>
              <TableCell>
                <Typography variant="body2">{p.type}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                  {p.workflowId}
                </Typography>
              </TableCell>
              <TableCell>
                <Chip size="small" color={STATE_COLOR[state] ?? 'default'} label={state} />
                {p.hold?.holds.map((h) => (
                  <Typography key={h.ref} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {h.reason}
                  </Typography>
                ))}
              </TableCell>
              <TableCell>
                <Objects objects={p.objects} />
              </TableCell>
              <TableCell>
                <RelativeTime iso={recent ? (p.closeTime ?? p.startTime) : p.startTime} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function LiquidProcessesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['liquid-processes'], queryFn: api.liquidProcesses, refetchInterval: 4000 });
  const [holding, setHolding] = useState(false);
  const release = useMutation({ mutationFn: (ref: string) => api.releaseLiquidHold(ref), onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-processes'] }) });
  const d = q.data;
  const processes = d?.running.filter((p) => p.type !== 'ApprovalWorkflow' && p.type !== 'lakeFlush') ?? [];
  const approvals = d?.running.filter((p) => p.type === 'ApprovalWorkflow' && p.approval) ?? [];
  const holds = [...new Map(processes.flatMap((p) => p.hold?.holds ?? []).map((h) => [h.ref, h])).values()];
  return (
    <>
      <PageHeader overline="Liquid enterprise" title="Business processes" subtitle="Durable, holdable workflows started by ontology events (Temporal namespace business). Hold by object, release, decide approvals." actions={<Button variant="contained" onClick={() => setHolding(true)}>Hold by object</Button>} />
      {q.isLoading && <Loading />}
      <ErrorAlert error={q.error} title="Could not load the business processes" />
      <ErrorAlert error={release.error} title="Release failed" />
      {d && (
        <Grid container spacing={3}>
          {holds.length > 0 && (
            <Grid size={12}>
              <Alert severity="warning">
                <Stack spacing={1}>
                  {holds.map((h) => (
                    <Stack key={h.ref} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                      <Typography variant="body2">
                        <b>{h.ref}</b> · {h.reason} · since <RelativeTime iso={h.since} />
                      </Typography>
                      <Button size="small" disabled={release.isPending} onClick={() => release.mutate(h.ref)}>
                        Release
                      </Button>
                    </Stack>
                  ))}
                </Stack>
              </Alert>
            </Grid>
          )}
          <Grid size={12}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Approvals ({approvals.length})
            </Typography>
            {approvals.length === 0 ? (
              <EmptyState title="No pending approvals" text="Four-eyes requests of the ontology server (ActionApprovalRequested) appear here as approval workflows." />
            ) : (
              <Grid container spacing={2}>
                {approvals.map((p) => (
                  <Grid key={p.workflowId} size={{ xs: 12, md: 6 }}>
                    <ApprovalCard p={p} />
                  </Grid>
                ))}
              </Grid>
            )}
          </Grid>
          <Grid size={12}>
            <Card variant="outlined">
              <CardHeader title={`Running (${processes.length})`} subheader={`${d.held} held`} />
              <CardContent>{processes.length === 0 ? <EmptyState title="No running processes" text="Creating a purchase order (create_purchase_order) starts a PurchaseOrderRelease workflow." /> : <ProcessTable rows={processes} />}</CardContent>
            </Card>
          </Grid>
          <Grid size={12}>
            <Card variant="outlined">
              <CardHeader title="Recently closed" />
              <CardContent>{d.recent.length === 0 ? <EmptyState title="Nothing closed yet" text="Completed, cancelled and failed workflows show up here." /> : <ProcessTable rows={d.recent} recent />}</CardContent>
            </Card>
          </Grid>
        </Grid>
      )}
      <HoldDialog open={holding} onClose={() => setHolding(false)} />
    </>
  );
}
