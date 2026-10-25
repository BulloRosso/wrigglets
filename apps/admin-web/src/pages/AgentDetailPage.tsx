import { useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import StopOutlined from '@mui/icons-material/StopOutlined';
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined';
import CloudSyncOutlined from '@mui/icons-material/CloudSyncOutlined';
import PauseOutlined from '@mui/icons-material/PauseOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import { ALL_AGENT_ROLES, type AgentStats, type AgentSummary } from '@cw/shared';
import {
  AgentPortrait,
  ConfirmDialog,
  KillSwitchChip,
  EmptyState,
  ErrorAlert,
  KeyValueList,
  Loading,
  PageHeader,
  RelativeTime,
  Sparkline,
  StatusChip,
  formatBytes,
  formatDateTime,
  formatRelative,
} from '@cw/ui';
import { api, avatarSrc, useMe } from '../api';
import { CollaborationTab, PortraitTab, SafetyTab } from '../components/AgentTabs';
import { AiBudgetTab } from '../components/AiBudgetTab';

function Overview({ a }: { a: AgentSummary }) {
  const h = a.health;
  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card sx={{ height: '100%' }}>
          <CardHeader title="Instance" />
          <CardContent sx={{ pt: 0 }}>
            <KeyValueList
              items={[
                ['Agent id', a.spec.agentId],
                ['URL', <Link href={a.url} target="_blank" rel="noreferrer">{a.url}</Link>],
                ['Image', <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{a.spec.image}</Typography>],
                ['Model', a.spec.model],
                ['Resources', `${a.spec.resources.cpus} CPU · ${a.spec.resources.memoryMb} MB`],
                ['Container', `${a.runtime.containerId ?? '–'} · ${a.runtime.detail}`],
                ['Started', a.runtime.startedAt ? `${formatDateTime(a.runtime.startedAt)} (${formatRelative(a.runtime.startedAt)})` : '–'],
                ['Restarts', a.runtime.restartCount ?? 0],
                ['Git identity', a.spec.gitEmail],
                ['Created', `${formatDateTime(a.spec.createdAt)} by ${a.spec.createdBy}`],
              ]}
            />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <Stack spacing={3}>
          <Card>
            <CardHeader title="Health" action={h ? <StatusChip status={h.status} /> : undefined} />
            <CardContent sx={{ pt: 0 }}>
              {h ? (
                <KeyValueList
                  items={[
                    ['Agent Harness', `${h.harness.state}${h.harness.version ? ` · opencode ${h.harness.version}` : ''} · ${h.harness.restarts} restart(s)`],
                    ['Temporal', `${h.temporal.state} · ${h.temporal.namespace}${h.temporal.error ? ` · ${h.temporal.error}` : ''}`],
                    ['Version', h.version],
                  ]}
                />
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Health endpoint not reachable{a.runtime.state === 'starting' ? ' yet (starting)' : ''}.
                </Typography>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Workspace lock" subheader="Singleton AgentWorkflow (FIFO)" />
            <CardContent sx={{ pt: 0 }}>
              {a.lock ? (
                <KeyValueList
                  items={[
                    ['Holder', a.lock.holder ? `${a.lock.holder.taskId} (since ${formatRelative(a.lock.holder.since)})` : 'none (idle)'],
                    ['Waiting', a.lock.waiting.length ? a.lock.waiting.map((w) => w.taskId).join(', ') : 'none'],
                    ['Grants total', a.lock.stats.grantsTotal],
                  ]}
                />
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Lock manager not running (agent never started?).
                </Typography>
              )}
            </CardContent>
          </Card>
        </Stack>
      </Grid>
    </Grid>
  );
}

function Monitoring({ agentId }: { agentId: string }) {
  const [samples, setSamples] = useState<AgentStats[]>([]);
  const q = useQuery({ queryKey: ['stats', agentId], queryFn: () => api.stats(agentId), refetchInterval: 3_000 });
  useEffect(() => {
    if (q.data) setSamples((s) => [...s.filter((x) => x.at !== q.data!.at), q.data!].slice(-60));
  }, [q.data]);
  const last = samples[samples.length - 1];
  if (!last) return q.isLoading ? <Loading /> : <EmptyState title="No statistics" text="The container is not running." />;
  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card>
          <CardHeader title="CPU" subheader={`${last.cpuPercent.toFixed(1)} %`} />
          <CardContent sx={{ pt: 0 }}>
            <Sparkline values={samples.map((s) => s.cpuPercent)} max={Math.max(100, ...samples.map((s) => s.cpuPercent))} label="CPU usage" />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card>
          <CardHeader title="Memory" subheader={`${formatBytes(last.memoryBytes)} of ${formatBytes(last.memoryLimitBytes)}`} />
          <CardContent sx={{ pt: 0 }}>
            <Sparkline values={samples.map((s) => s.memoryBytes)} max={last.memoryLimitBytes} color="var(--mui-palette-secondary-main)" label="Memory usage" />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={12}>
        <Typography variant="body2" color="text.secondary">
          Network: {formatBytes(last.netRxBytes)} received · {formatBytes(last.netTxBytes)} sent · sampled every 3 s, last {samples.length} samples.
        </Typography>
      </Grid>
    </Grid>
  );
}

function Logs({ agentId }: { agentId: string }) {
  const [lines, setLines] = useState<Array<{ line: string; stream: string }>>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const es = new EventSource(`/api/agents/${encodeURIComponent(agentId)}/logs?tail=300`);
    es.onmessage = (m) => {
      if (pausedRef.current) return;
      const ev = JSON.parse(m.data) as { line: string; stream: string };
      setLines((l) => [...l, ev].slice(-2000));
    };
    return () => es.close();
  }, [agentId]);
  useEffect(() => {
    if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, paused]);
  const shown = useMemo(() => (filter ? lines.filter((l) => l.line.toLowerCase().includes(filter.toLowerCase())) : lines), [lines, filter]);
  return (
    <Card>
      <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}>
        <TextField label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ flexGrow: 1 }} />
        <Button startIcon={paused ? <PlayArrowOutlined /> : <PauseOutlined />} onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button onClick={() => setLines([])}>Clear</Button>
      </Stack>
      <Box ref={box} sx={{ height: '60vh', overflow: 'auto', bgcolor: '#0b0f14', color: '#d6e2f0', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, p: 1.5 }}>
        {shown.map((l, i) => (
          <Box key={i} sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: l.stream === 'stderr' ? '#ff9e9e' : undefined }}>
            {l.line}
          </Box>
        ))}
        {shown.length === 0 && <Box sx={{ color: '#7d8a99' }}>Waiting for log output…</Box>}
      </Box>
    </Card>
  );
}

function Tasks({ a }: { a: AgentSummary }) {
  const q = useQuery({ queryKey: ['tasks', a.spec.agentId], queryFn: () => api.tasks({ agentId: a.spec.agentId, limit: 50 }), refetchInterval: 10_000 });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <EmptyState title="No tasks yet" />;
  return (
    <Card>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Task</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Type</TableCell>
            <TableCell>Requested by</TableCell>
            <TableCell>Approved by</TableCell>
            <TableCell>Started</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {q.data.map((t) => (
            <TableRow key={t.taskId} hover>
              <TableCell>
                <Link href={`${a.url}/tasks/${encodeURIComponent(t.taskId)}`} target="_blank" rel="noreferrer">
                  {t.title}
                </Link>
              </TableCell>
              <TableCell>
                <StatusChip status={String(t.status)} />
              </TableCell>
              <TableCell>{t.type}</TableCell>
              <TableCell>{t.requestedBy}</TableCell>
              <TableCell>{t.approvedBy.join(', ') || '–'}</TableCell>
              <TableCell>
                <RelativeTime iso={t.startTime} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function Access({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['access', agentId], queryFn: () => api.access(agentId) });
  const set = useMutation({
    mutationFn: ({ userId, roles }: { userId: string; roles: string[] }) => api.setAccess(agentId, userId, roles),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['access', agentId] }),
  });
  if (q.isLoading) return <Loading />;
  return (
    <Card>
      <CardHeader
        title="Who may use this agent"
        subheader={
          <>
            Roles are issued in the <code>roles</code> claim of the ID token for this agent's OIDC client. Changes apply at the next sign-in. Inherited roles come from “all agents” assignments or the
            Platform.Admin role. Manage people on the <RouterLink to="/users">Users</RouterLink> page.
          </>
        }
      />
      <ErrorAlert error={q.error ?? set.error} />
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Person</TableCell>
            {ALL_AGENT_ROLES.map((r) => (
              <TableCell key={r} align="center">
                {r.replace('Agent.', '')}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {q.data?.map((u) => (
            <TableRow key={u.userId} sx={{ opacity: u.disabled ? 0.5 : 1 }}>
              <TableCell>
                <Typography variant="body2">{u.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {u.email}
                  {u.disabled ? ' · disabled' : ''}
                </Typography>
              </TableCell>
              {ALL_AGENT_ROLES.map((r) => {
                const inherited = u.inheritedRoles.includes(r);
                const checked = inherited || u.roles.includes(r);
                return (
                  <TableCell key={r} align="center">
                    <Tooltip title={inherited ? 'Inherited (all agents / platform admin)' : ''}>
                      <span>
                        <Checkbox
                          checked={checked}
                          disabled={inherited || set.isPending}
                          onChange={(e) => {
                            let roles = e.target.checked ? [...new Set([...u.roles, r])] : u.roles.filter((x) => x !== r);
                            if (e.target.checked && r !== 'Agent.User') roles = [...new Set([...roles, 'Agent.User'])];
                            if (!e.target.checked && r === 'Agent.User') roles = [];
                            set.mutate({ userId: u.userId, roles });
                          }}
                        />
                      </span>
                    </Tooltip>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function Settings({ a }: { a: AgentSummary }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const images = useQuery({ queryKey: ['images'], queryFn: api.images });
  const [f, setF] = useState({ displayName: a.spec.displayName, description: a.spec.description ?? '', image: a.spec.image, cpus: a.spec.resources.cpus, memoryMb: a.spec.resources.memoryMb });
  const [deleting, setDeleting] = useState(false);
  const [purge, setPurge] = useState(false);
  const save = useMutation({ mutationFn: () => api.updateAgent(a.spec.agentId, f), onSuccess: () => void qc.invalidateQueries({ queryKey: ['agent', a.spec.agentId] }) });
  const del = useMutation({
    mutationFn: () => api.deleteAgent(a.spec.agentId, purge, true),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      navigate('/agents');
    },
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const imageOptions = [...new Set([a.spec.image, ...(images.data?.map((i) => i.reference) ?? [])])];
  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 7 }}>
        <Card>
          <CardHeader title="Configuration" subheader="Saving re-creates the container. The workspace volume is kept; running steps are retried by Temporal." />
          <CardContent>
            <Stack spacing={2.5}>
              <TextField label="Display name" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} />
              <TextField label="Description" value={f.description} onChange={(e) => set('description', e.target.value)} multiline minRows={2} />
              <TextField select label="Image" value={f.image} onChange={(e) => set('image', e.target.value)}>
                {imageOptions.map((i) => (
                  <MenuItem key={i} value={i}>
                    {i}
                  </MenuItem>
                ))}
              </TextField>
              <Typography variant="body2" color="text.secondary">
                Model, spend limit and the AI key are managed on the <b>AI &amp; budget</b> tab.
              </Typography>
              <Stack direction="row" spacing={2}>
                <TextField type="number" label="CPUs" value={f.cpus} onChange={(e) => set('cpus', Number(e.target.value))} />
                <TextField type="number" label="Memory (MB)" value={f.memoryMb} onChange={(e) => set('memoryMb', Number(e.target.value))} />
              </Stack>
              <ErrorAlert error={save.error} />
              <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', alignItems: 'center' }}>
                {save.isSuccess && (
                  <Typography variant="body2" color="success.main">
                    Saved and redeployed.
                  </Typography>
                )}
                <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? 'Redeploying…' : 'Save & redeploy'}
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 5 }}>
        <Card sx={{ borderColor: 'error.main' }}>
          <CardHeader title="Danger zone" />
          <CardContent sx={{ pt: 0 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Deleting removes the container and the OIDC client. Optionally purge the workspace volume and the agent's schedules and running workflows. Audit data in the workspace is lost when purging.
            </Typography>
            <Button color="error" variant="outlined" startIcon={<DeleteOutlined />} onClick={() => setDeleting(true)}>
              Delete agent
            </Button>
          </CardContent>
        </Card>
      </Grid>
      <ConfirmDialog
        open={deleting}
        title={`Delete ${a.spec.displayName}?`}
        text="This cannot be undone."
        confirmLabel="Delete"
        confirmColor="error"
        busy={del.isPending}
        error={del.error}
        onClose={() => setDeleting(false)}
        onConfirm={() => del.mutate()}
      >
        <FormControlLabel sx={{ mt: 1 }} control={<Switch checked={purge} onChange={(e) => setPurge(e.target.checked)} color="error" />} label="Also delete the workspace volume, schedules and running workflows" />
      </ConfirmDialog>
    </Grid>
  );
}

function AgentAudit({ agentId }: { agentId: string }) {
  const q = useQuery({ queryKey: ['audit', agentId], queryFn: () => api.audit(agentId) });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <EmptyState title="No admin actions recorded" />;
  return (
    <Card>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>When</TableCell>
            <TableCell>Who</TableCell>
            <TableCell>Action</TableCell>
            <TableCell>Details</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {q.data.map((e, i) => (
            <TableRow key={i}>
              <TableCell>{formatDateTime(e.at)}</TableCell>
              <TableCell>{e.by}</TableCell>
              <TableCell>{e.action}</TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{e.details ? JSON.stringify(e.details) : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

const TABS = ['Overview', 'Monitoring', 'Logs', 'Tasks', 'Access', 'AI & budget', 'Portrait', 'Collaboration', 'Safety', 'Settings', 'Audit'] as const;

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const me = useMe();
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const q = useQuery({ queryKey: ['agent', id], queryFn: () => api.agent(id), refetchInterval: 5_000 });
  const action = useMutation({
    mutationFn: (act: 'start' | 'stop' | 'restart' | 'redeploy') => api.agentAction(id, act),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['agent', id] }),
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error ?? new Error('Agent not found')} />;
  const a = q.data;
  const running = a.runtime.state === 'running' || a.runtime.state === 'starting';

  return (
    <>
      <PageHeader
        overline={<Link component={RouterLink} to="/agents">Agents</Link>}
        title={
          <Stack component="span" direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <AgentPortrait src={avatarSrc(a.spec.agentId)} mood={a.killSwitch && a.killSwitch.level !== 'normal' ? 'fearful' : 'neutral'} name={a.spec.displayName} size={64} version={a.avatarVersion} />
            <span>{a.spec.displayName}</span>
          </Stack>
        }
        subtitle={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
            <StatusChip status={a.runtime.state} size="medium" />
            {a.health && <StatusChip status={a.health.status} size="medium" />}
            {a.killSwitch && <KillSwitchChip level={a.killSwitch.level} reason={a.killSwitch.entry?.reason} source={a.killSwitch.source === 'global' ? 'global' : 'agent'} size="medium" />}
            <Typography variant="body2" color="text.secondary">
              {a.spec.agentId} · {a.url}
            </Typography>
          </Stack>
        }
        actions={
          <>
            <Button variant="contained" endIcon={<OpenInNewOutlined />} href={a.url} target="_blank" rel="noreferrer" disabled={!running}>
              Open agent UI
            </Button>
            {running ? (
              <Button startIcon={<StopOutlined />} onClick={() => action.mutate('stop')} disabled={action.isPending}>
                Stop
              </Button>
            ) : (
              <Button startIcon={<PlayArrowOutlined />} onClick={() => action.mutate('start')} disabled={action.isPending || a.runtime.state === 'missing'}>
                Start
              </Button>
            )}
            <Button startIcon={<RestartAltOutlined />} onClick={() => action.mutate('restart')} disabled={action.isPending || !running}>
              Restart
            </Button>
            <Tooltip title="Re-create the container from the registry entry (also re-registers the OIDC client)">
              <Button startIcon={<CloudSyncOutlined />} onClick={() => action.mutate('redeploy')} disabled={action.isPending}>
                Redeploy
              </Button>
            </Tooltip>
          </>
        }
      />
      <ErrorAlert error={action.error} />
      <Tabs value={tab} onChange={(_, v: (typeof TABS)[number]) => setTab(v)} variant="scrollable" sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}>
        {TABS.map((t) => (
          <Tab key={t} value={t} label={t} />
        ))}
      </Tabs>
      {tab === 'Overview' && <Overview a={a} />}
      {tab === 'Monitoring' && <Monitoring agentId={id} />}
      {tab === 'Logs' && <Logs agentId={id} />}
      {tab === 'Tasks' && <Tasks a={a} />}
      {tab === 'Access' && <Access agentId={id} />}
      {tab === 'AI & budget' && <AiBudgetTab a={a} />}
      {tab === 'Portrait' && <PortraitTab a={a} />}
      {tab === 'Collaboration' && <CollaborationTab a={a} />}
      {tab === 'Safety' && <SafetyTab a={a} />}
      {tab === 'Settings' && <Settings a={a} />}
      {tab === 'Audit' && <AgentAudit agentId={id} />}
      {me.data && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 3 }}>
          Temporal: <Link href={`${me.data.temporalUiUrl}/namespaces/${me.data.temporalNamespace}/workflows?query=${encodeURIComponent(`AgentId="${a.spec.agentId}"`)}`} target="_blank" rel="noreferrer">workflows of this agent</Link>
        </Typography>
      )}
    </>
  );
}
