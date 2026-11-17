import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
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
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import GppMaybeOutlined from '@mui/icons-material/GppMaybeOutlined';
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined';
import { GUARD_CATEGORIES, type GuardConfig, type SecurityAlert } from '@cw/shared';
import { EmptyState, ErrorAlert, Loading, RelativeTime, errorMessage } from '@cw/ui';
import { api } from '../api';

const CATEGORY_LABEL: Record<(typeof GUARD_CATEGORIES)[number], string> = {
  none: 'Unspecified',
  data_exfiltration: 'Data exfiltration',
  prompt_injection: 'Prompt injection',
  multi_turn_injection: 'Multi-turn injection',
  scope_violation: 'Out of scope',
};

/* ------------------------------------------------------------------ alerts */

/** Dashboard banner: open security alerts of the exfiltration guard. Renders nothing when there are none. */
export function SecurityAlertBanner() {
  const q = useQuery({
    queryKey: ['security-alerts'],
    queryFn: api.securityAlerts,
    refetchInterval: 10_000,
  });
  const open = q.data?.alerts.filter((a) => a.status === 'open') ?? [];
  if (!open.length) return null;
  return (
    <Alert
      severity="error"
      icon={<GppMaybeOutlined />}
      sx={{ mb: 2, '& .MuiAlert-message': { minWidth: 0 } }}
      action={
        <Button component={RouterLink} to="/safety?tab=alerts" color="inherit" size="small">
          Review
        </Button>
      }
    >
      <AlertTitle>
        {open.length === 1 ? '1 security alert' : `${open.length} security alerts`}: the exfiltration guard stopped {open.length === 1 ? 'an agent' : 'agents'}
      </AlertTitle>
      {/* one line, the newest alert; the list is on the Safety page (UI review ADM-01) */}
      <Typography variant="body2" noWrap title={open[0]!.reason}>
        Newest: <strong>{open[0]!.agentId}</strong> · {CATEGORY_LABEL[open[0]!.category]} via <code>{open[0]!.tool}</code> — {open[0]!.reason}
      </Typography>
    </Alert>
  );
}

function AckDialog({ alert, onClose }: { alert: SecurityAlert; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const ack = useMutation({
    mutationFn: () => api.acknowledgeAlert(alert.id, note.trim() || undefined),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['security-alerts'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Acknowledge security alert</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2">
            Acknowledging records that you reviewed the alert. It does <strong>not</strong> resume the agent: it stays on its kill-switch level until you lower it under <em>Kill switch</em> above.
          </Typography>
          <TextField label="Note (what did you check?)" value={note} onChange={(e) => setNote(e.target.value)} multiline minRows={2} />
          {ack.error && <Alert severity="error">{errorMessage(ack.error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => ack.mutate()} disabled={ack.isPending}>
          Acknowledge
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** One alert: one line (when, agent, category, reason); the blocked call and the full evaluation on expand. */
function AlertRow({ a, onAck }: { a: SecurityAlert; onAck: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TableRow
        hover
        onClick={() => setOpen(!open)}
        sx={{
          cursor: 'pointer',
          '& td': { borderBottom: open ? 'none' : undefined },
          boxShadow: a.status === 'open' ? (t) => `inset 3px 0 0 ${t.palette.error.main}` : undefined,
        }}
      >
        <TableCell sx={{ whiteSpace: 'nowrap', width: 120 }}>
          <RelativeTime iso={a.at} />
        </TableCell>
        <TableCell sx={{ width: 130 }}>
          <Link component={RouterLink} to={`/agents/${a.agentId}`} onClick={(e) => e.stopPropagation()}>
            {a.agentId}
          </Link>
        </TableCell>
        <TableCell sx={{ width: 200 }}>
          <Chip size="small" variant="outlined" color={a.status === 'open' ? 'error' : 'default'} label={`${CATEGORY_LABEL[a.category]} · ${a.confidence}%`} />
        </TableCell>
        <TableCell sx={{ maxWidth: 0 }}>
          <Typography variant="body2" noWrap title={a.reason}>
            {a.reason}
          </Typography>
        </TableCell>
        <TableCell align="right" sx={{ width: 130 }}>
          {a.status === 'open' ? (
            <Button
              size="small"
              variant="outlined"
              onClick={(e) => {
                e.stopPropagation();
                onAck();
              }}
            >
              Acknowledge
            </Button>
          ) : (
            <Typography variant="caption" color="text.secondary">
              acknowledged
            </Typography>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={5} sx={{ pt: 0 }}>
            <Stack spacing={1} sx={{ pl: 1 }}>
              <Typography variant="body2">{a.reason}</Typography>
              <Typography
                variant="body2"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: 12,
                  wordBreak: 'break-all',
                }}
                color="text.secondary"
              >
                {a.callSummary}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Task {a.taskId ?? '–'}
                {a.status === 'acknowledged' ? ` · acknowledged by ${a.acknowledgedBy}${a.note ? `: ${a.note}` : ''}` : ''}
              </Typography>
            </Stack>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function SecurityAlertsCard() {
  const q = useQuery({
    queryKey: ['security-alerts'],
    queryFn: api.securityAlerts,
    refetchInterval: 10_000,
  });
  const [acking, setAcking] = useState<SecurityAlert | undefined>();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [limit, setLimit] = useState(10);
  if (!q.data) return <Loading />;
  const shown = q.data.alerts.filter((a) => filter === 'all' || a.status === 'open');
  return (
    <Card>
      <CardHeader
        title="Security alerts"
        subheader="Raised when the exfiltration guard blocked a tool call; the task is cancelled and the agent put on the guard's kill-switch level. Click a row for the blocked call."
        action={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v: 'open' | 'all' | null) => v && setFilter(v)}>
              <ToggleButton value="open">Open ({q.data.open})</ToggleButton>
              <ToggleButton value="all">All ({q.data.alerts.length})</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        }
      />
      <ErrorAlert error={q.error} />
      {shown.length === 0 ? (
        <CardContent>
          <EmptyState title={filter === 'open' ? 'No open alerts' : 'No alerts'} text={filter === 'open' ? 'Everything the guard blocked has been acknowledged.' : 'The guard has not blocked anything yet.'} />
        </CardContent>
      ) : (
        <>
          <Table size="small" sx={{ tableLayout: 'fixed' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 120 }}>When</TableCell>
                <TableCell sx={{ width: 130 }}>Agent</TableCell>
                <TableCell sx={{ width: 200 }}>Category</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell sx={{ width: 130 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.slice(0, limit).map((a) => (
                <AlertRow key={a.id} a={a} onAck={() => setAcking(a)} />
              ))}
            </TableBody>
          </Table>
          {shown.length > limit && (
            <CardContent sx={{ py: 1 }}>
              <Button size="small" onClick={() => setLimit(limit + 25)}>
                Show more ({shown.length - limit} more)
              </Button>
            </CardContent>
          )}
        </>
      )}
      {acking && <AckDialog alert={acking} onClose={() => setAcking(undefined)} />}
    </Card>
  );
}

/* ------------------------------------------------------------------ guard configuration */

export function GuardConfigCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['guard-config'], queryFn: api.guardConfig });
  const [draft, setDraft] = useState<GuardConfig | undefined>();
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data.config);
  }, [q.data, draft]);
  const save = useMutation({
    mutationFn: () => api.saveGuardConfig(draft!),
    onSuccess: async (r) => {
      setDraft(r.config);
      await qc.invalidateQueries({ queryKey: ['guard-config'] });
    },
  });
  if (!q.data || !draft) return <Loading />;
  const patch = (p: Partial<GuardConfig>) => setDraft({ ...draft, ...p });
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data.config);
  const isDefault = draft.systemPrompt.trim() === q.data.defaultSystemPrompt.trim();
  const tooShort = draft.systemPrompt.trim().length < 100;
  return (
    <Card>
      <CardHeader
        title="Exfiltration guard"
        subheader="Before every tool call an evaluation agent (a small model) checks the last model round-trips of the task for multi-turn prompt injection and data exfiltration. Changes apply to all agents within ~20 s."
        action={
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => save.mutate()} disabled={!dirty || tooShort || save.isPending}>
              Save
            </Button>
          </Stack>
        }
      />
      <CardContent>
        <ErrorAlert error={save.error} />
        <Stack spacing={3}>
          <FormControlLabel
            control={<Switch checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />}
            label={draft.enabled ? 'Guard is on: every tool call is evaluated' : 'Guard is OFF: tool calls are not evaluated'}
          />
          {!draft.enabled && <Alert severity="warning">With the guard off, agents with an e-mail or web tool are exposed to data exfiltration through prompt injection.</Alert>}
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 4 }}>
              <TextField
                label="Evaluation model"
                value={draft.model}
                onChange={(e) => patch({ model: e.target.value })}
                placeholder={q.data.platformModel}
                helperText={`Empty = the platform's small model (${q.data.platformModel}). Must be available to the agents' AI keys.`}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 6, md: 2 }}>
              <TextField
                label="Context (model calls)"
                type="number"
                value={draft.contextCalls}
                onChange={(e) =>
                  patch({
                    contextCalls: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
                  })
                }
                helperText="Response API calls the evaluator sees"
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <TextField
                select
                label="After a block"
                value={draft.haltLevel}
                onChange={(e) =>
                  patch({
                    haltLevel: e.target.value as GuardConfig['haltLevel'],
                  })
                }
                helperText="Kill-switch level of the agent"
                fullWidth
              >
                <MenuItem value="stopped">Stopped (cancel all tasks, stop container)</MenuItem>
                <MenuItem value="paused">Paused (no new steps)</MenuItem>
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, md: 3 }}>
              <TextField select label="If the evaluation fails" value={draft.failMode} onChange={(e) => patch({ failMode: e.target.value as GuardConfig['failMode'] })} helperText="Model down or invalid answer" fullWidth>
                <MenuItem value="block">Refuse the tool call (fail closed)</MenuItem>
                <MenuItem value="allow">Let the tool call run</MenuItem>
              </TextField>
            </Grid>
          </Grid>
          <TextField
            label="Tools that are never evaluated"
            value={draft.skipTools.join(', ')}
            onChange={(e) =>
              patch({
                skipTools: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            helperText="Comma separated tool names. Default: the local workspace tools (read, edit, apply_patch, …); MCP gateway tools are always evaluated unless listed"
            fullWidth
          />
          <div>
            <Stack
              direction="row"
              sx={{
                alignItems: 'center',
                justifyContent: 'space-between',
                mb: 1,
              }}
            >
              <Typography variant="subtitle2">System prompt of the evaluation agent</Typography>
              <Button size="small" startIcon={<RestartAltOutlined />} disabled={isDefault} onClick={() => patch({ systemPrompt: q.data.defaultSystemPrompt })}>
                Restore default
              </Button>
            </Stack>
            <TextField
              value={draft.systemPrompt}
              onChange={(e) => patch({ systemPrompt: e.target.value })}
              multiline
              minRows={14}
              maxRows={32}
              fullWidth
              error={tooShort}
              helperText={
                tooShort
                  ? 'At least 100 characters'
                  : `${draft.systemPrompt.length.toLocaleString()} characters${isDefault ? ' · default prompt' : ' · customized'}. The JSON answer format is appended by the platform and cannot be edited here.`
              }
              slotProps={{
                htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } },
              }}
            />
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}
