import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
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
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddOutlined from '@mui/icons-material/AddOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import { KILL_LEVELS, type SafetyRule, type UpstreamServer } from '@cw/shared';
import { AgentPortrait, EmptyState, ErrorAlert, KILL_LEVEL_META, KillSwitchChip, Loading, PageHeader, RelativeTime, StatusChip, errorMessage, formatNumber, userLocale } from '@cw/ui';
import { api, avatarSrc } from '../api';
import { KillSwitchDialog } from '../components/KillSwitch';
import { GuardConfigCard, SecurityAlertsCard } from '../components/Security';

const RULE_TEXT: Record<SafetyRule['kind'], { label: string; unit: string }> = {
  permission_violation: { label: 'Harness permission requests', unit: 'requests / hour' },
  tokens_per_hour: { label: 'Token spike', unit: 'tokens / hour' },
  tool_denials: { label: 'Denied or failed tool calls', unit: 'calls / 10 min' },
  tool_rate: { label: 'Tool call rate', unit: 'calls / minute' },
  failed_streak: { label: 'Failed tasks in a row', unit: 'tasks' },
};

function KillSwitchOverview() {
  const qc = useQueryClient();
  const ks = useQuery({ queryKey: ['killswitch'], queryFn: api.killSwitch, refetchInterval: 10_000 });
  const agents = useQuery({ queryKey: ['agents', false], queryFn: () => api.agents(false) });
  const [editing, setEditing] = useState<string | undefined>();
  if (!ks.data || !agents.data) return <Loading />;
  const g = ks.data.state.global;
  return (
    <Card>
      <CardHeader
        title="Kill switch"
        subheader="Effective level = the stricter of the global and the agent level. Automatic trips are never lifted automatically."
        action={<KillSwitchChip level={g.level} reason={g.reason} source="global" showNormal />}
      />
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Agent</TableCell>
            <TableCell>Effective level</TableCell>
            <TableCell>Reason</TableCell>
            <TableCell>Since</TableCell>
            <TableCell align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {agents.data.map((a) => {
            const eff = ks.data.effective[a.spec.agentId] ?? { level: 'normal', source: 'none' };
            const own = ks.data.state.agents[a.spec.agentId];
            return (
              <TableRow key={a.spec.agentId} hover>
                <TableCell>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                    <AgentPortrait src={avatarSrc(a.spec.agentId)} name={a.spec.displayName} size={32} version={a.avatarVersion} />
                    <Link component={RouterLink} to={`/agents/${a.spec.agentId}`}>
                      {a.spec.displayName}
                    </Link>
                  </Stack>
                </TableCell>
                <TableCell>
                  <KillSwitchChip level={eff.level} reason={eff.entry?.reason} source={eff.source === 'global' ? 'global' : 'agent'} showNormal />
                </TableCell>
                <TableCell>
                  {eff.entry?.auto && <Chip size="small" variant="outlined" color="warning" label={`auto · ${eff.entry.auto.rule}`} sx={{ mr: 1 }} />}
                  {eff.entry?.reason ?? '–'}
                </TableCell>
                <TableCell>{eff.entry ? <RelativeTime iso={eff.entry.at} /> : '–'}</TableCell>
                <TableCell align="right">
                  <Button size="small" onClick={() => setEditing(a.spec.agentId)}>
                    Change
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {editing && (
        <KillSwitchDialog
          open
          title={`Kill switch — ${editing}`}
          current={ks.data.state.agents[editing]}
          onClose={() => setEditing(undefined)}
          onApply={async (level, reason) => {
            await api.setAgentKillSwitch(editing, level, reason);
            await qc.invalidateQueries();
          }}
        />
      )}
      {agents.data.length === 0 && <CardContent>No agents yet.</CardContent>}
    </Card>
  );
}

function Collaboration() {
  const agents = useQuery({ queryKey: ['agents', false], queryFn: () => api.agents(false) });
  if (!agents.data) return null;
  const edges = agents.data.flatMap((a) => (a.spec.peers ?? []).map((p) => ({ from: a.spec, to: agents.data.find((x) => x.spec.agentId === p)?.spec })));
  return (
    <Card sx={{ height: '100%' }}>
      <CardHeader title="A2A discovery sets" subheader="Who may delegate to whom (one-directional). Default: isolated. Edit on the agent's Collaboration tab." />
      <CardContent sx={{ pt: 0 }}>
        {edges.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            All agents are isolated.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {edges.map((e) => (
              <Stack key={`${e.from.agentId}>${e.to?.agentId}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <AgentPortrait src={avatarSrc(e.from.agentId)} name={e.from.displayName} size={28} />
                <Typography variant="body2">{e.from.displayName}</Typography>
                <ArrowForwardOutlined fontSize="small" color="action" />
                {e.to && <AgentPortrait src={avatarSrc(e.to.agentId)} name={e.to.displayName} size={28} />}
                <Typography variant="body2">{e.to?.displayName ?? '(deleted)'}</Typography>
              </Stack>
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

function Rules() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['safety-rules'], queryFn: api.safetyRules, refetchInterval: 30_000 });
  const [rules, setRules] = useState<SafetyRule[] | undefined>();
  useEffect(() => {
    if (q.data && !rules) setRules(q.data.rules);
  }, [q.data, rules]);
  const save = useMutation({ mutationFn: () => api.saveSafetyRules(rules!), onSuccess: () => void qc.invalidateQueries({ queryKey: ['safety-rules'] }) });
  const run = useMutation({ mutationFn: api.runSafety, onSuccess: () => void qc.invalidateQueries({ queryKey: ['safety-rules'] }) });
  if (!q.data || !rules) return <Loading />;
  const patch = (i: number, p: Partial<SafetyRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const tripped = q.data.observations.filter((o) => o.tripped);
  return (
    <Card>
      <CardHeader
        title="Automatic triggers"
        subheader={`Evaluated every 30 s${q.data.lastRun ? ` · last run ${new Date(q.data.lastRun).toLocaleTimeString(userLocale)}` : ''}`}
        action={
          <Stack direction="row" spacing={1}>
            <Button startIcon={<PlayArrowOutlined />} onClick={() => run.mutate()} disabled={run.isPending}>
              Evaluate now
            </Button>
            <Button variant="contained" onClick={() => save.mutate()} disabled={save.isPending || JSON.stringify(rules) === JSON.stringify(q.data.rules)}>
              Save
            </Button>
          </Stack>
        }
      />
      <ErrorAlert error={save.error ?? run.error} />
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>On</TableCell>
            <TableCell>Rule</TableCell>
            <TableCell>Threshold</TableCell>
            <TableCell>Trips to</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rules.map((r, i) => (
            <TableRow key={r.id}>
              <TableCell>
                <Switch checked={r.enabled} onChange={(e) => patch(i, { enabled: e.target.checked })} />
              </TableCell>
              <TableCell>
                <Typography variant="body2">{RULE_TEXT[r.kind].label}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {r.id}
                </Typography>
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  type="number"
                  value={r.threshold}
                  onChange={(e) => patch(i, { threshold: Math.max(1, Number(e.target.value) || 1) })}
                  sx={{ width: 140 }}
                  helperText={RULE_TEXT[r.kind].unit}
                />
              </TableCell>
              <TableCell>
                <TextField select size="small" value={r.level} onChange={(e) => patch(i, { level: e.target.value as SafetyRule['level'] })} sx={{ width: 140 }}>
                  {KILL_LEVELS.filter((l) => l !== 'normal').map((l) => (
                    <MenuItem key={l} value={l}>
                      {KILL_LEVEL_META[l].label}
                    </MenuItem>
                  ))}
                </TextField>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <CardContent>
        {tripped.length ? (
          <Alert severity="warning">
            Tripped in the last evaluation: {tripped.map((o) => `${o.agentId} · ${o.ruleId} (${formatNumber(o.value)} ≥ ${formatNumber(o.threshold)})`).join(', ')}
          </Alert>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {q.data.observations.length} observation(s) in the last evaluation, none above threshold.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

const emptyUpstream: UpstreamServer = { name: '', url: '', headers: {}, enabled: true, auth: 'static', oboFallback: 'deny' };

function UpstreamDialog({ initial, onClose }: { initial: UpstreamServer; onClose: () => void }) {
  const qc = useQueryClient();
  const [u, setU] = useState(initial);
  const [headers, setHeaders] = useState(
    Object.entries(initial.headers).map(([k, v]) => ({ name: k, value: typeof v === 'string' ? v : v.secretRef, secret: typeof v !== 'string' })),
  );
  // Entra OBO is optional: offered only when a tenant is configured (or the upstream already uses it)
  const entra = useQuery({ queryKey: ['entra'], queryFn: api.entraAvailable, staleTime: 60_000 });
  const oboOffered = entra.data?.available === true || initial.auth === 'obo';
  const obo = u.auth === 'obo';
  const save = useMutation({
    mutationFn: () =>
      api.saveUpstream({ ...u, oboScope: obo ? u.oboScope : undefined, oboFallback: obo ? u.oboFallback : 'deny', headers: obo ? {} : Object.fromEntries(headers.filter((h) => h.name).map((h) => [h.name, h.secret ? { secretRef: h.value } : h.value])) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['gateway'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{initial.name ? `Upstream MCP server "${initial.name}"` : 'Add upstream MCP server'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={u.name} disabled={!!initial.name} onChange={(e) => setU({ ...u, name: e.target.value })} helperText="Tool prefix: <name>__<tool>" />
          <TextField label="Description" value={u.description ?? ''} onChange={(e) => setU({ ...u, description: e.target.value })} />
          <TextField label="URL (Streamable HTTP)" value={u.url} onChange={(e) => setU({ ...u, url: e.target.value })} />
          {oboOffered && (
            <TextField
              select
              label="Authentication"
              value={u.auth}
              onChange={(e) => setU({ ...u, auth: e.target.value as UpstreamServer['auth'] })}
              helperText={obo ? 'The gateway sends an Entra token per call that identifies the agent and the user (On-Behalf-Of).' : 'Static headers below, the same for every call.'}
            >
              <MenuItem value="static">Static headers</MenuItem>
              <MenuItem value="obo">Entra On-Behalf-Of (agent + user identity)</MenuItem>
            </TextField>
          )}
          {obo && (
            <>
              <TextField
                label="Scope"
                value={u.oboScope ?? ''}
                onChange={(e) => setU({ ...u, oboScope: e.target.value })}
                placeholder="api://<mcp-server-app-id>/.default"
                helperText="Resource the token is issued for (the MCP server's Entra application)."
              />
              <TextField
                select
                label="Tasks without a signed-in user (schedules, agent-to-agent)"
                value={u.oboFallback}
                onChange={(e) => setU({ ...u, oboFallback: e.target.value as UpstreamServer['oboFallback'] })}
                helperText="Agent-only additionally requires the agent to allow it on its Identity tab. A task with a user never falls back."
              >
                <MenuItem value="deny">Deny</MenuItem>
                <MenuItem value="agent-only">Use the agent's own token (no user identity)</MenuItem>
              </TextField>
            </>
          )}
          {!obo && <Typography variant="subtitle2">Headers</Typography>}
          {!obo && headers.map((h, i) => (
            <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <TextField size="small" label="Header" value={h.name} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <TextField
                size="small"
                sx={{ flex: 1 }}
                label={h.secret ? 'Key Vault secret name' : 'Value (not secret)'}
                value={h.value}
                onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <Tooltip title="Value comes from Key Vault">
                <Switch checked={h.secret} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))} />
              </Tooltip>
              <IconButton onClick={() => setHeaders(headers.filter((_, j) => j !== i))} aria-label="Remove header">
                <DeleteOutlined />
              </IconButton>
            </Stack>
          ))}
          {!obo && <Button startIcon={<AddOutlined />} onClick={() => setHeaders([...headers, { name: 'Authorization', value: '', secret: true }])} sx={{ alignSelf: 'flex-start' }}>
            Add header
          </Button>}
          <Stack direction="row" sx={{ alignItems: 'center' }}>
            <Switch checked={u.enabled} onChange={(e) => setU({ ...u, enabled: e.target.checked })} />
            <Typography variant="body2">Enabled</Typography>
          </Stack>
          <ErrorAlert error={save.error} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => save.mutate()} disabled={!u.name || !u.url || save.isPending || (obo && !u.oboScope)}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function Gateway() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gateway'], queryFn: api.gateway, refetchInterval: 15_000 });
  const [editing, setEditing] = useState<UpstreamServer | undefined>();
  const del = useMutation({ mutationFn: api.deleteUpstream, onSuccess: () => void qc.invalidateQueries({ queryKey: ['gateway'] }) });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  const status = q.data.health.status === 'ok' ? 'ok' : q.data.health.status === 'stale' ? 'degraded' : 'down';
  return (
    <Card>
      <CardHeader
        title="MCP gateway"
        subheader="The only MCP endpoint agents see. Upstream credentials are resolved from Key Vault by the gateway."
        action={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <StatusChip status={status} />
            <Button startIcon={<AddOutlined />} onClick={() => setEditing(emptyUpstream)}>
              Upstream
            </Button>
          </Stack>
        }
      />
      <ErrorAlert error={del.error} />
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Upstream</TableCell>
            <TableCell>URL</TableCell>
            <TableCell>Credentials</TableCell>
            <TableCell align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {q.data.upstreams.map((u) => (
            <TableRow key={u.name}>
              <TableCell>
                <Typography variant="body2">{u.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {u.description}
                </Typography>
              </TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{u.url}</TableCell>
              <TableCell>
                {Object.entries(u.headers).map(([k, v]) => (
                  <Chip key={k} size="small" variant="outlined" icon={typeof v === 'string' ? undefined : <KeyOutlined />} label={typeof v === 'string' ? k : `${k} ← ${v.secretRef}`} sx={{ mr: 0.5 }} />
                ))}
                {!u.enabled && <Chip size="small" label="disabled" />}
              </TableCell>
              <TableCell align="right">
                <IconButton onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`}>
                  <EditOutlined />
                </IconButton>
                <IconButton onClick={() => del.mutate(u.name)} aria-label={`Delete ${u.name}`}>
                  <DeleteOutlined />
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <CardContent>
        <Typography variant="subtitle2" gutterBottom>
          Tools offered by the upstreams ({q.data.tools.length})
        </Typography>
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          {q.data.tools.map((t) => (
            <Tooltip key={t.name} title={t.description ?? ''}>
              <Chip size="small" label={t.name} sx={{ fontFamily: 'monospace' }} />
            </Tooltip>
          ))}
        </Stack>
      </CardContent>
      {editing && <UpstreamDialog initial={editing} onClose={() => setEditing(undefined)} />}
    </Card>
  );
}

function Secrets() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['secrets'], queryFn: api.secrets });
  const [form, setForm] = useState<{ name: string; value: string; isNew: boolean } | undefined>();
  const set = useMutation({
    mutationFn: () => api.setSecret(form!.name, form!.value),
    onSuccess: async () => {
      setForm(undefined);
      await qc.invalidateQueries({ queryKey: ['secrets'] });
    },
  });
  const del = useMutation({ mutationFn: api.deleteSecret, onSuccess: () => void qc.invalidateQueries({ queryKey: ['secrets'] }) });
  if (q.isLoading) return <Loading />;
  if (!q.data?.enabled) return <EmptyState title="No Key Vault configured" text="Set KEYVAULT_URL for the control plane." />;
  return (
    <Card>
      <CardHeader
        title="Key Vault secrets"
        subheader={`${q.data.vaultUrl ?? ''} · values are write-only`}
        action={
          <Button startIcon={<AddOutlined />} onClick={() => setForm({ name: '', value: '', isNew: true })}>
            Secret
          </Button>
        }
      />
      <ErrorAlert error={del.error ?? q.error} />
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Updated</TableCell>
            <TableCell>Set by</TableCell>
            <TableCell align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {q.data.secrets.map((s) => (
            <TableRow key={s.name}>
              <TableCell sx={{ fontFamily: 'monospace' }}>{s.name}</TableCell>
              <TableCell>{s.updatedOn ? <RelativeTime iso={s.updatedOn} /> : '–'}</TableCell>
              <TableCell>{s.tags?.setBy ?? '–'}</TableCell>
              <TableCell align="right">
                <Button size="small" onClick={() => setForm({ name: s.name, value: '', isNew: false })}>
                  Rotate
                </Button>
                <IconButton onClick={() => del.mutate(s.name)} aria-label={`Delete ${s.name}`}>
                  <DeleteOutlined />
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {form && (
        <Dialog open onClose={() => setForm(undefined)} maxWidth="sm" fullWidth>
          <DialogTitle>{form.isNew ? 'New secret' : `Rotate "${form.name}"`}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {form.isNew && <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} helperText="Letters, digits and dashes" />}
              <TextField label="Value" type="password" autoComplete="new-password" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              {set.error && <Alert severity="error">{errorMessage(set.error)}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setForm(undefined)}>Cancel</Button>
            <Button variant="contained" disabled={!form.name || !form.value || set.isPending} onClick={() => set.mutate()}>
              Save
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Card>
  );
}

export function SafetyPage() {
  return (
    <>
      <PageHeader title="Safety & tools" subtitle="Security alerts, kill switch, automatic triggers, exfiltration guard, MCP gateway, credentials and agent collaboration" />
      <Grid container spacing={3}>
        <Grid size={{ xs: 12 }}>
          <SecurityAlertsCard />
        </Grid>
        <Grid size={{ xs: 12, lg: 8 }}>
          <KillSwitchOverview />
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          <Collaboration />
        </Grid>
        <Grid size={{ xs: 12 }}>
          <Rules />
        </Grid>
        <Grid size={{ xs: 12 }}>
          <GuardConfigCard />
        </Grid>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Gateway />
        </Grid>
        <Grid size={{ xs: 12, lg: 5 }}>
          <Secrets />
        </Grid>
      </Grid>
    </>
  );
}
