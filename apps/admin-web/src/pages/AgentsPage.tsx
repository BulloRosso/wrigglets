import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActions from '@mui/material/CardActions';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddOutlined from '@mui/icons-material/AddOutlined';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import StopOutlined from '@mui/icons-material/StopOutlined';
import SmartToyOutlined from '@mui/icons-material/SmartToyOutlined';
import { AGENT_ID_PATTERN, slugify, type AgentSummary } from '@cw/shared';
import { AgentPortrait, EmptyState, ErrorAlert, KeyValueList, KillSwitchChip, Loading, PageHeader, StatusChip, formatRelative } from '@cw/ui';
import { api, avatarSrc } from '../api';

export function CreateAgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const images = useQuery({ queryKey: ['images'], queryFn: api.images, enabled: open });
  const [f, setF] = useState({ displayName: '', agentId: '', description: '', model: '', image: '', cpus: 1, memoryMb: 2048, start: true });
  const [idTouched, setIdTouched] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const agentId = idTouched ? f.agentId : slugify(f.displayName, 30);
  const create = useMutation({
    mutationFn: () =>
      api.createAgent({
        agentId,
        displayName: f.displayName,
        description: f.description || undefined,
        model: f.model || undefined,
        image: f.image || undefined,
        cpus: f.cpus,
        memoryMb: f.memoryMb,
        start: f.start,
      }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      onClose();
      navigate(`/agents/${a.spec.agentId}`);
    },
  });
  const idValid = AGENT_ID_PATTERN.test(agentId);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New agent</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Creates an OIDC client on the OAuth server, a persistent workspace volume and an agent container (API + Temporal worker + Agent Harness). On Azure this becomes an App Service pulling the image from the private ACR.
        </Typography>
        <Stack spacing={2.5}>
          <TextField label="Display name" required value={f.displayName} onChange={(e) => set('displayName', e.target.value)} helperText="How people address the colleague, e.g. “Max”" autoFocus />
          <TextField
            label="Agent id"
            required
            value={agentId}
            onChange={(e) => {
              setIdTouched(true);
              set('agentId', e.target.value.toLowerCase());
            }}
            error={!!agentId && !idValid}
            helperText="Lower-case letters, digits and dashes. Used in workflow ids, task queue and URLs; cannot be changed later."
          />
          <TextField label="Description" value={f.description} onChange={(e) => set('description', e.target.value)} multiline minRows={2} />
          <TextField select label="Image" value={f.image} onChange={(e) => set('image', e.target.value)} helperText="Local images of the agent repository (ACR repository on Azure)">
            <MenuItem value="">Default image</MenuItem>
            {images.data?.map((i) => (
              <MenuItem key={i.reference} value={i.reference}>
                {i.reference} · {formatRelative(i.created)}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Model" value={f.model} onChange={(e) => set('model', e.target.value)} placeholder="platform default" helperText="Model id of the AI gateway (or the mock in local development)" />
          <Stack direction="row" spacing={2}>
            <TextField type="number" label="CPUs" value={f.cpus} onChange={(e) => set('cpus', Number(e.target.value))} slotProps={{ htmlInput: { min: 0.25, max: 8, step: 0.25 } }} />
            <TextField type="number" label="Memory (MB)" value={f.memoryMb} onChange={(e) => set('memoryMb', Number(e.target.value))} slotProps={{ htmlInput: { min: 512, max: 16384, step: 256 } }} />
          </Stack>
          <FormControlLabel control={<Switch checked={f.start} onChange={(e) => set('start', e.target.checked)} />} label="Start immediately" />
          <ErrorAlert error={create.error} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!f.displayName.trim() || !idValid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Provisioning…' : 'Create agent'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AgentCard({ a }: { a: AgentSummary }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const action = useMutation({
    mutationFn: (act: 'start' | 'stop') => api.agentAction(a.spec.agentId, act),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['agents'] }),
  });
  const running = a.runtime.state === 'running' || a.runtime.state === 'starting';
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardHeader
        avatar={<AgentPortrait src={avatarSrc(a.spec.agentId)} name={a.spec.displayName} size={56} version={a.avatarVersion} />}
        title={a.spec.displayName}
        subheader={a.spec.agentId}
        action={<StatusChip status={a.runtime.state} />}
        sx={{ cursor: 'pointer' }}
        onClick={() => navigate(`/agents/${a.spec.agentId}`)}
      />
      <CardContent sx={{ flexGrow: 1, pt: 0 }}>
        {a.spec.description && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {a.spec.description}
          </Typography>
        )}
        <KeyValueList
          dense
          items={[
            ['Health', a.health ? <StatusChip status={a.health.status} /> : '–'],
            ['Kill switch', a.killSwitch ? <KillSwitchChip level={a.killSwitch.level} reason={a.killSwitch.entry?.reason} source={a.killSwitch.source === 'global' ? 'global' : 'agent'} showNormal /> : '–'],
            ['Collaborates with', a.spec.peers?.length ? a.spec.peers.join(', ') : 'isolated'],
            ['Harness', a.health ? `${a.health.harness.state}${a.health.harness.version ? ` · v${a.health.harness.version}` : ''}` : '–'],
            ['Workspace', a.lock?.holder ? `busy (${a.lock.waiting.length} waiting)` : a.lock ? 'idle' : '–'],
            ['Open tasks', a.openTasks ?? '–'],
            ['Model', a.spec.model],
            ['Image', <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12 }}>{a.spec.image}</Typography>],
          ]}
        />
        <ErrorAlert error={action.error} />
      </CardContent>
      <CardActions sx={{ flexWrap: 'wrap' }}>
        <Button size="small" endIcon={<OpenInNewOutlined />} href={a.url} target="_blank" rel="noreferrer" disabled={!running}>
          Open UI
        </Button>
        {running ? (
          <Button size="small" startIcon={<StopOutlined />} onClick={() => action.mutate('stop')} disabled={action.isPending}>
            Stop
          </Button>
        ) : (
          <Button size="small" startIcon={<PlayArrowOutlined />} onClick={() => action.mutate('start')} disabled={action.isPending || a.runtime.state === 'missing'}>
            Start
          </Button>
        )}
        <Button size="small" onClick={() => navigate(`/agents/${a.spec.agentId}`)}>
          Manage
        </Button>
        <Chip size="small" variant="outlined" label={`:${a.spec.hostPort}`} sx={{ ml: 'auto' }} />
      </CardActions>
    </Card>
  );
}

export function AgentsPage() {
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['agents'], queryFn: () => api.agents(true), refetchInterval: 5_000 });
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Each agent is one container (API, Temporal worker, Agent Harness) with its own persistent workspace."
        actions={
          <Button variant="contained" startIcon={<AddOutlined />} onClick={() => setCreating(true)}>
            New agent
          </Button>
        }
      />
      <ErrorAlert error={q.error} />
      {q.isLoading && <Loading />}
      {q.data?.length === 0 && (
        <EmptyState
          title="No agents yet"
          text="Spin up the first AI colleague. You can grant people access afterwards."
          action={
            <Button variant="outlined" startIcon={<AddOutlined />} onClick={() => setCreating(true)}>
              New agent
            </Button>
          }
        />
      )}
      <Grid container spacing={2}>
        {q.data?.map((a) => (
          <Grid key={a.spec.agentId} size={{ xs: 12, md: 6, xl: 4 }}>
            <AgentCard a={a} />
          </Grid>
        ))}
      </Grid>
      {creating && <CreateAgentDialog open onClose={() => setCreating(false)} />}
    </>
  );
}
