import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ConfirmDialog, EmptyState, ErrorAlert, KeyValueList, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { api, type LiquidOverlay } from '../api';

/*
 * Policy as code (ADR-0044): what OPA enforces right now. Overlays only add restrictions (deny or an obligation) and
 * take effect at OPA's next bundle poll (5–10 s); removing one loosens the policy and is done by a person.
 */

const EFFECT = { deny: { label: 'deny', color: 'error' }, require_four_eyes: { label: 'four eyes', color: 'warning' }, require_step_up: { label: 'step-up', color: 'warning' } } as const;
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function AddOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [effect, setEffect] = useState<LiquidOverlay['effect']>('deny');
  const [reason, setReason] = useState('');
  const [actions, setActions] = useState('');
  const [classes, setClasses] = useState('');
  const [upstreams, setUpstreams] = useState('');
  const [agents, setAgents] = useState('');
  const [hours, setHours] = useState('');
  const add = useMutation({
    mutationFn: () => {
      const match = Object.fromEntries(Object.entries({ actions: list(actions), classes: list(classes), upstreams: list(upstreams), agents: list(agents) }).filter(([, v]) => v.length));
      return api.addLiquidOverlay({ effect, reason, match, ...(hours ? { expires_at: new Date(Date.now() + Number(hours) * 3_600_000).toISOString() } : {}) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['liquid-policy'] });
      onClose();
    },
  });
  return (
    <ConfirmDialog open={open} title="Add a tightening overlay" text="An overlay can only restrict: deny matching calls or require an obligation. OPA picks it up within about 10 seconds." confirmLabel="Add overlay" busy={add.isPending} error={add.error} onConfirm={() => add.mutate()} onClose={onClose}>
      <Stack spacing={2} sx={{ mt: 1 }}>
        <TextField select label="Effect" value={effect} onChange={(e) => setEffect(e.target.value as LiquidOverlay['effect'])}>
          <MenuItem value="deny">Deny matching calls</MenuItem>
          <MenuItem value="require_four_eyes">Require four eyes (a person approves)</MenuItem>
          <MenuItem value="require_step_up">Require step-up (denied in the prototype)</MenuItem>
        </TextField>
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
        <TextField label="Actions (comma-separated)" value={actions} onChange={(e) => setActions(e.target.value)} placeholder="create_purchase_order, cancel_purchase_order" />
        <TextField label="Classes" value={classes} onChange={(e) => setClasses(e.target.value)} placeholder="Supplier, PurchaseOrder" />
        <TextField label="Upstreams" value={upstreams} onChange={(e) => setUpstreams(e.target.value)} placeholder="erp" />
        <TextField label="Agents" value={agents} onChange={(e) => setAgents(e.target.value)} placeholder="sofa-lara" />
        <TextField label="Expires after (hours, optional)" value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9.]/g, ''))} />
      </Stack>
    </ConfirmDialog>
  );
}

export function LiquidPoliciesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['liquid-policy'], queryFn: api.liquidPolicy, refetchInterval: 5000 });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<LiquidOverlay | undefined>();
  const remove = useMutation({
    mutationFn: (id: string) => api.removeLiquidOverlay(id),
    onSuccess: () => {
      setRemoving(undefined);
      void qc.invalidateQueries({ queryKey: ['liquid-policy'] });
    },
  });
  const d = q.data;
  return (
    <>
      <PageHeader overline="Liquid enterprise" title="Policies" subtitle="Policy as code with OPA: decided at the gateway and, with the objects, at the ontology server. Fail closed." actions={<Button variant="contained" onClick={() => setAdding(true)}>Add overlay</Button>} />
      {q.isLoading && <Loading />}
      <ErrorAlert error={q.error} title="Could not load the policy status" />
      {d && (
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 4 }}>
            <Card variant="outlined">
              <CardHeader title="Bundle" subheader="policies/liquid + roles + ontology data + overlays" />
              <CardContent>
                {!d.lastFetchByOpa && <Alert severity="warning" sx={{ mb: 2 }}>OPA has not fetched a bundle yet. Until it does, every policy decision is a denial (fail closed).</Alert>}
                <KeyValueList
                  items={[
                    ['Revision', <code>{d.bundle?.revision ?? '—'}</code>],
                    ['Built', d.bundle ? <RelativeTime iso={d.bundle.builtAt} /> : '—'],
                    ['Last poll by OPA', d.lastFetchByOpa ? <><RelativeTime iso={d.lastFetchByOpa.at} /> · {d.lastFetchByOpa.notModified ? 'unchanged' : 'new revision'}</> : '—'],
                    ['Policies', d.bundle ? d.bundle.files.join(', ') : '—'],
                  ]}
                />
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 8 }}>
            <Card variant="outlined">
              <CardHeader title={`Overlays in effect (${d.overlays.length})`} subheader="Tighten automatically, loosen only by a person" />
              <CardContent>
                {d.overlays.length === 0 ? (
                  <EmptyState title="No overlays" text="The base policies apply: roles, read-only planning, destructive actions after an approved plan, four eyes on payment-critical objects outside approved tasks." />
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Id</TableCell>
                        <TableCell>Effect</TableCell>
                        <TableCell>Matches</TableCell>
                        <TableCell>Reason</TableCell>
                        <TableCell>Source</TableCell>
                        <TableCell />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {d.overlays.map((o) => (
                        <TableRow key={o.id}>
                          <TableCell sx={{ fontFamily: 'monospace' }}>{o.id}</TableCell>
                          <TableCell>
                            <Chip size="small" color={EFFECT[o.effect].color} label={EFFECT[o.effect].label} />
                          </TableCell>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                            {Object.entries(o.match)
                              .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`)
                              .join(' · ')}
                          </TableCell>
                          <TableCell>
                            {o.reason}
                            {o.expires_at && (
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                expires <RelativeTime iso={o.expires_at} />
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption">{o.source}</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              {o.createdBy}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Button size="small" color="error" onClick={() => setRemoving(o)}>
                              Remove
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </Grid>
          <Grid size={12}>
            <Card variant="outlined">
              <CardHeader title="Recent decisions" subheader="Reported by OPA (decision logs), newest first" />
              <CardContent>
                {d.decisions.length === 0 ? (
                  <EmptyState title="No decisions yet" text="Decisions appear here a few seconds after a tool call or an action was decided." />
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>When</TableCell>
                        <TableCell>Point</TableCell>
                        <TableCell>Agent</TableCell>
                        <TableCell>Action</TableCell>
                        <TableCell>Decision</TableCell>
                        <TableCell>Reason</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {d.decisions.map((x, i) => (
                        <TableRow key={`${x.at}-${i}`}>
                          <TableCell>
                            <RelativeTime iso={x.at} />
                          </TableCell>
                          <TableCell>{x.path.includes('gateway') ? 'gateway' : x.path.includes('object') ? 'ontology server' : x.path}</TableCell>
                          <TableCell>{x.input.agent ?? x.input.caller ?? '—'}</TableCell>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{x.input.action ?? x.input.tool ?? '—'}</TableCell>
                          <TableCell>
                            <Chip size="small" color={x.allow ? (x.obligations.length ? 'warning' : 'success') : 'error'} label={x.allow ? (x.obligations.length ? x.obligations.join(', ') : 'allow') : 'deny'} />
                          </TableCell>
                          <TableCell sx={{ fontSize: 12 }}>{x.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}
      <AddOverlay open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={!!removing}
        title={`Remove overlay ${removing?.id}`}
        text="Removing an overlay loosens the policy. This is recorded in the audit log with your name."
        confirmLabel="Remove"
        confirmColor="error"
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onClose={() => setRemoving(undefined)}
      />
    </>
  );
}
