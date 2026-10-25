import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AutoAwesomeOutlined from '@mui/icons-material/AutoAwesomeOutlined';
import UploadOutlined from '@mui/icons-material/UploadOutlined';
import RestoreOutlined from '@mui/icons-material/RestoreOutlined';
import RefreshOutlined from '@mui/icons-material/RefreshOutlined';
import { A2A_TOOL, AVATAR_MOODS, AVATAR_MOOD_LABEL, type AgentSummary, type AvatarMood } from '@cw/shared';
import { AgentPortrait, EmptyState, ErrorAlert, KILL_LEVEL_META, KillSwitchChip, Loading, formatDateTime, formatRelative } from '@cw/ui';
import { api, avatarSrc } from '../api';
import { KillSwitchDialog } from './KillSwitch';

const DEFAULT_PROMPT = 'A friendly, competent office colleague; keep the character of the reference image.';

/* ------------------------------------------------------------------ Portrait */

export function PortraitTab({ a }: { a: AgentSummary }) {
  const qc = useQueryClient();
  const agentId = a.spec.agentId;
  const q = useQuery({
    queryKey: ['avatar', agentId],
    queryFn: () => api.avatar(agentId),
    refetchInterval: (query) => (query.state.data?.job?.state === 'running' ? 2_000 : false),
  });
  const [prompt, setPrompt] = useState<string | undefined>();
  const [refVersion, setRefVersion] = useState(Date.now());
  const file = useRef<HTMLInputElement>(null);
  const job = q.data?.job;
  const running = job?.state === 'running';
  const version = q.data?.meta?.generatedAt;
  useEffect(() => {
    if (job?.state === 'done') void qc.invalidateQueries({ queryKey: ['agent', agentId] });
  }, [job?.state, qc, agentId]);

  const generate = useMutation({
    mutationFn: (moods?: AvatarMood[]) => api.generateAvatar(agentId, (prompt ?? a.spec.avatarPrompt ?? DEFAULT_PROMPT).trim(), moods),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['avatar', agentId] }),
  });
  const upload = useMutation({
    mutationFn: (f: File) => api.uploadReference(f),
    onSuccess: () => setRefVersion(Date.now()),
  });
  const reset = useMutation({ mutationFn: api.resetReference, onSuccess: () => setRefVersion(Date.now()) });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 4 }}>
        <Card sx={{ height: '100%' }}>
          <CardHeader title="Guiding image" subheader="Shared by all agents; the model edits it into each portrait" />
          <CardContent sx={{ pt: 0 }}>
            <Box
              component="img"
              src={`/api/avatars/reference?v=${refVersion}`}
              alt="Reference image"
              sx={{ width: '100%', maxWidth: 280, aspectRatio: '1', objectFit: 'contain', display: 'block', mx: 'auto', borderRadius: 2, bgcolor: 'action.hover' }}
            />
            <Stack direction="row" spacing={1} sx={{ mt: 2, justifyContent: 'center' }}>
              <input
                ref={file}
                type="file"
                accept="image/png"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = '';
                }}
              />
              <Button startIcon={<UploadOutlined />} onClick={() => file.current?.click()} disabled={upload.isPending}>
                Replace
              </Button>
              <Button startIcon={<RestoreOutlined />} onClick={() => reset.mutate()} disabled={reset.isPending}>
                Default
              </Button>
            </Stack>
            <ErrorAlert error={upload.error ?? reset.error} />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 8 }}>
        <Card>
          <CardHeader title="Portrait prompt" subheader={`Model ${q.data.model} · four moods: neutral, happy, fearful, in doubt`} />
          <CardContent sx={{ pt: 0 }}>
            {!q.data.enabled && (
              <Alert severity="info" sx={{ mb: 2 }}>
                Portrait generation is disabled: set <code>OPENAI_API_KEY</code> in your environment and restart the stack.
              </Alert>
            )}
            <TextField
              fullWidth
              multiline
              minRows={3}
              label="Describe this agent"
              value={prompt ?? a.spec.avatarPrompt ?? DEFAULT_PROMPT}
              onChange={(e) => setPrompt(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 2000 } }}
            />
            <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'center' }}>
              <Button variant="contained" startIcon={<AutoAwesomeOutlined />} disabled={!q.data.enabled || running || generate.isPending} onClick={() => generate.mutate(undefined)}>
                {q.data.meta ? 'Regenerate all' : 'Generate portraits'}
              </Button>
              {q.data.meta && (
                <Typography variant="body2" color="text.secondary">
                  Last generated {formatRelative(q.data.meta.generatedAt)} by {q.data.meta.by}
                </Typography>
              )}
            </Stack>
            <ErrorAlert error={generate.error} />
            {job?.state === 'failed' && (
              <Alert severity="error" sx={{ mt: 2 }}>
                Generation failed: {job.error}
              </Alert>
            )}
            {running && <LinearProgress sx={{ mt: 2 }} />}
          </CardContent>
        </Card>
        <Grid container spacing={2} sx={{ mt: 1 }}>
          {AVATAR_MOODS.map((mood) => {
            const state = job?.moods[mood];
            return (
              <Grid key={mood} size={{ xs: 6, sm: 3 }}>
                <Card variant="outlined">
                  <CardContent sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                    <AgentPortrait src={avatarSrc(agentId)} mood={mood} name={a.spec.displayName} size={128} version={q.data.meta?.moods[mood]?.generatedAt ?? version} />
                    <Typography variant="subtitle2">{AVATAR_MOOD_LABEL[mood]}</Typography>
                    {running && state && state !== 'done' ? (
                      <Chip size="small" label={state} color={state === 'failed' ? 'error' : 'info'} />
                    ) : (
                      <Button size="small" startIcon={<RefreshOutlined />} disabled={!q.data.enabled || running || !q.data.meta} onClick={() => generate.mutate([mood])}>
                        Redo
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </Grid>
            );
          })}
        </Grid>
      </Grid>
    </Grid>
  );
}

/* ------------------------------------------------------------------ Collaboration (A2A discovery set) */

export function CollaborationTab({ a }: { a: AgentSummary }) {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ['agents', false], queryFn: () => api.agents(false) });
  const [peers, setPeers] = useState<string[]>(a.spec.peers ?? []);
  const save = useMutation({
    mutationFn: () => api.updateAgent(a.spec.agentId, { peers }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent', a.spec.agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  if (!agents.data) return <Loading />;
  const others = agents.data.filter((x) => x.spec.agentId !== a.spec.agentId);
  const callers = others.filter((x) => x.spec.peers?.includes(a.spec.agentId));
  const label = (agentId: string) => others.find((x) => x.spec.agentId === agentId)?.spec.displayName ?? agentId;
  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 7 }}>
        <Card>
          <CardHeader
            title="Discovery set"
            subheader={`Colleagues ${a.spec.displayName} may find (${A2A_TOOL.list}) and delegate tasks to (${A2A_TOOL.send}). Empty = isolated.`}
          />
          <CardContent sx={{ pt: 0 }}>
            <Autocomplete
              multiple
              options={others.map((x) => x.spec.agentId)}
              value={peers}
              onChange={(_, v) => setPeers(v)}
              getOptionLabel={label}
              renderOption={(props, agentId) => (
                <Box component="li" {...props} key={agentId} sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
                  <AgentPortrait src={avatarSrc(agentId)} name={label(agentId)} size={28} />
                  {label(agentId)}
                  <Typography variant="caption" color="text.secondary">
                    {agentId}
                  </Typography>
                </Box>
              )}
              renderInput={(params) => <TextField {...params} label="May delegate to" placeholder={peers.length ? '' : 'Isolated'} />}
            />
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button variant="contained" onClick={() => save.mutate()} disabled={save.isPending || JSON.stringify(peers) === JSON.stringify(a.spec.peers ?? [])}>
                Save
              </Button>
              <Button onClick={() => setPeers([])} disabled={!peers.length}>
                Isolate
              </Button>
            </Stack>
            <ErrorAlert error={save.error} />
            <Alert severity="info" sx={{ mt: 2 }}>
              Delegations run as normal tasks on the colleague (with its own approval policy) on behalf of the person who requested the original task. Calls are mediated and audited by
              the MCP gateway; paused or stopped colleagues are not reachable.
            </Alert>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 5 }}>
        <Card>
          <CardHeader title="Who may delegate to this agent" />
          <CardContent sx={{ pt: 0 }}>
            {callers.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nobody.
              </Typography>
            ) : (
              <Stack spacing={1}>
                {callers.map((c) => (
                  <Stack key={c.spec.agentId} direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                    <AgentPortrait src={avatarSrc(c.spec.agentId)} name={c.spec.displayName} size={32} version={c.avatarVersion} />
                    <Typography variant="body2">{c.spec.displayName}</Typography>
                  </Stack>
                ))}
              </Stack>
            )}
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}

/* ------------------------------------------------------------------ Safety (kill switch, tool allow-list, tool calls) */

export function SafetyTab({ a }: { a: AgentSummary }) {
  const qc = useQueryClient();
  const agentId = a.spec.agentId;
  const [dialog, setDialog] = useState(false);
  const ks = useQuery({ queryKey: ['killswitch'], queryFn: api.killSwitch, refetchInterval: 10_000 });
  const gateway = useQuery({ queryKey: ['gateway'], queryFn: api.gateway });
  const tools = useQuery({ queryKey: ['agent-tools', agentId], queryFn: () => api.agentTools(agentId) });
  const calls = useQuery({ queryKey: ['tool-calls', agentId], queryFn: () => api.toolCalls(agentId), refetchInterval: 10_000 });
  const [allowed, setAllowed] = useState<string[] | undefined>();
  useEffect(() => {
    if (tools.data && !allowed) setAllowed(tools.data.allowedTools);
  }, [tools.data, allowed]);
  const save = useMutation({
    mutationFn: () => api.setAgentTools(agentId, allowed ?? []),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agent-tools', agentId] }),
  });

  const eff = ks.data?.effective[agentId];
  const own = ks.data?.state.agents[agentId];
  const available = (gateway.data?.tools ?? []).map((t) => t.name);
  const toggle = (name: string, on: boolean) => setAllowed((cur) => (on ? [...(cur ?? []), name] : (cur ?? []).filter((x) => x !== name)));

  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 5 }}>
        <Card sx={{ height: '100%' }}>
          <CardHeader title="Kill switch" action={eff && <KillSwitchChip level={eff.level} reason={eff.entry?.reason} source={eff.source === 'global' ? 'global' : 'agent'} showNormal size="medium" />} />
          <CardContent sx={{ pt: 0 }}>
            {eff?.entry && eff.level !== 'normal' ? (
              <Typography variant="body2" sx={{ mb: 2 }}>
                {KILL_LEVEL_META[eff.level].label} since {formatDateTime(eff.entry.at)} by {eff.entry.by}
                {eff.entry.auto ? ` (automatic: rule ${eff.entry.auto.rule}${eff.entry.auto.detail ? `, ${eff.entry.auto.detail}` : ''})` : ''}
                {eff.entry.reason ? ` — ${eff.entry.reason}` : ''}.
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                No restrictions.
              </Typography>
            )}
            {eff?.source === 'global' && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                The global kill switch applies; lifting the agent level does not override it.
              </Alert>
            )}
            <Button variant="outlined" color="error" onClick={() => setDialog(true)}>
              Change level
            </Button>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 7 }}>
        <Card>
          <CardHeader
            title="Allowed MCP tools"
            subheader="Patterns <upstream>__<tool>, * as wildcard. A2A tools follow the discovery set."
            action={
              <Button variant="contained" onClick={() => save.mutate()} disabled={!allowed || save.isPending || JSON.stringify(allowed) === JSON.stringify(tools.data?.allowedTools)}>
                Save
              </Button>
            }
          />
          <CardContent sx={{ pt: 0 }}>
            {!allowed ? (
              <Loading />
            ) : (
              <>
                {available.length === 0 && <Typography variant="body2" color="text.secondary">The gateway reports no upstream tools.</Typography>}
                <Stack>
                  {available.map((t) => (
                    <FormControlLabel
                      key={t}
                      control={<Checkbox checked={allowed.includes(t) || allowed.includes('*')} disabled={allowed.includes('*')} onChange={(e) => toggle(t, e.target.checked)} />}
                      label={<Typography sx={{ fontFamily: 'monospace', fontSize: 14 }}>{t}</Typography>}
                    />
                  ))}
                </Stack>
                <Autocomplete
                  multiple
                  freeSolo
                  options={[]}
                  value={allowed.filter((x) => !available.includes(x))}
                  onChange={(_, v) => setAllowed([...allowed.filter((x) => available.includes(x)), ...v.map(String)])}
                  renderInput={(params) => <TextField {...params} size="small" label="Additional patterns" placeholder="e.g. demo__*" sx={{ mt: 1 }} />}
                />
              </>
            )}
            <ErrorAlert error={save.error ?? tools.error} />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12 }}>
        <Card>
          <CardHeader title="Recent tool calls" subheader="Audited by the MCP gateway (arguments are not stored, only sizes)" />
          {!calls.data?.length ? (
            <CardContent>
              <EmptyState title="No tool calls yet" />
            </CardContent>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>When</TableCell>
                  <TableCell>Tool</TableCell>
                  <TableCell>Outcome</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Details</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {calls.data.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell>{formatDateTime(c.at)}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>{c.tool}</TableCell>
                    <TableCell>
                      <Chip size="small" label={c.outcome} color={c.outcome === 'ok' ? 'success' : c.outcome === 'denied' ? 'warning' : 'error'} variant="outlined" />
                    </TableCell>
                    <TableCell>{c.durationMs} ms</TableCell>
                    <TableCell sx={{ fontSize: 13 }}>
                      {[c.reason, c.peer && `peer ${c.peer}`, c.remoteTaskId && `task ${c.remoteTaskId}`, `${c.argBytes} B in`, c.resultBytes !== undefined && `${c.resultBytes} B out`]
                        .filter(Boolean)
                        .join(' · ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Grid>
      {dialog && (
        <KillSwitchDialog
          open
          title={`Kill switch — ${a.spec.displayName}`}
          current={own}
          onClose={() => setDialog(false)}
          onApply={async (level, reason) => {
            await api.setAgentKillSwitch(agentId, level, reason);
            await qc.invalidateQueries();
          }}
        />
      )}
    </Grid>
  );
}
