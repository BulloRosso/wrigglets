import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
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
import Typography from '@mui/material/Typography';
import HubOutlined from '@mui/icons-material/HubOutlined';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import DnsOutlined from '@mui/icons-material/DnsOutlined';
import { AgentPortrait, EmptyState, ErrorAlert, KillSwitchChip, Loading, PageHeader, RelativeTime, StatusChip } from '@cw/ui';
import { api, avatarSrc } from '../api';

function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warning' | 'error' | 'success' }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Typography variant="overline" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h4" color={tone ? `${tone}.main` : 'text.primary'}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

function Service({ icon, title, state, detail }: { icon: ReactNode; title: string; state: string; detail?: ReactNode }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardHeader avatar={icon} title={title} action={<StatusChip status={state} />} subheader={detail} slotProps={{ subheader: { sx: { wordBreak: 'break-all' } } }} />
    </Card>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 10_000 });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents(true), refetchInterval: 10_000 });
  const tasks = useQuery({ queryKey: ['tasks', 'all'], queryFn: () => api.tasks({ limit: 15 }), refetchInterval: 10_000 });
  const o = overview.data;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="State of the platform: Temporal, identity provider, agent runtime and the work of all agents." />
      <ErrorAlert error={overview.error} />
      {!o ? (
        <Loading />
      ) : (
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid size={{ xs: 12, md: 4 }}>
            <Service icon={<HubOutlined color="primary" />} title="Temporal" state={o.temporal.state} detail={`${o.temporal.address} · ${o.temporal.namespace}${o.temporal.version ? ` · v${o.temporal.version}` : ''}`} />
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Service icon={<KeyOutlined color="primary" />} title="OAuth server" state={o.oauth.state} detail={o.oauth.issuer} />
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Service icon={<DnsOutlined color="primary" />} title={`Runtime (${o.runtime.kind})`} state={o.runtime.state} detail={o.runtime.detail} />
          </Grid>
          <Grid size={{ xs: 6, md: 2 }}>
            <Metric label="Agents" value={`${o.agents.running}/${o.agents.total}`} />
          </Grid>
          <Grid size={{ xs: 6, md: 2 }}>
            <Metric label="Open tasks" value={o.tasks.open} />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <Metric label="Awaiting approval" value={o.tasks.awaitingApproval} tone={o.tasks.awaitingApproval ? 'warning' : undefined} />
          </Grid>
          <Grid size={{ xs: 6, md: 2.5 }}>
            <Metric label="Completed (24 h)" value={o.tasks.completed24h} tone="success" />
          </Grid>
          <Grid size={{ xs: 12, md: 2.5 }}>
            <Metric label="Failed (24 h)" value={o.tasks.failed24h} tone={o.tasks.failed24h ? 'error' : undefined} />
          </Grid>
        </Grid>
      )}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, xl: 5 }}>
          <Card>
            <CardHeader title="Agents" subheader="Containers, health and workspace lock" />
            {agents.isLoading ? (
              <Loading />
            ) : !agents.data?.length ? (
              <EmptyState title="No agents yet" text="Create the first agent on the Agents page." />
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Agent</TableCell>
                    <TableCell>Container</TableCell>
                    <TableCell>Health</TableCell>
                    <TableCell>Working on</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {agents.data.map((a) => (
                    <TableRow key={a.spec.agentId} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/agents/${a.spec.agentId}`)}>
                      <TableCell>
                        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                          <AgentPortrait src={avatarSrc(a.spec.agentId)} name={a.spec.displayName} size={36} version={a.avatarVersion} />
                          <div>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              {a.spec.displayName}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {a.spec.agentId}
                            </Typography>
                          </div>
                          {a.killSwitch && <KillSwitchChip level={a.killSwitch.level} reason={a.killSwitch.entry?.reason} source={a.killSwitch.source === 'global' ? 'global' : 'agent'} />}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <StatusChip status={a.runtime.state} />
                      </TableCell>
                      <TableCell>{a.health ? <StatusChip status={a.health.status} /> : '–'}</TableCell>
                      <TableCell>
                        {a.lock?.holder ? <Chip size="small" color="info" label={`busy · ${a.lock.waiting.length} waiting`} /> : <Chip size="small" variant="outlined" label="idle" />}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </Grid>
        <Grid size={{ xs: 12, xl: 7 }}>
          <Card>
            <CardHeader title="Recent tasks" subheader="Across all agents (Temporal visibility)" />
            {tasks.isLoading ? (
              <Loading />
            ) : !tasks.data?.length ? (
              <EmptyState title="No tasks yet" />
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Task</TableCell>
                    <TableCell>Agent</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Requested by</TableCell>
                    <TableCell>Started</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tasks.data.map((t) => {
                    const agent = agents.data?.find((a) => a.spec.agentId === t.agentId);
                    return (
                      <TableRow key={t.taskId} hover>
                        <TableCell>
                          {agent ? (
                            <Typography component="a" variant="body2" href={`${agent.url}/tasks/${encodeURIComponent(t.taskId)}`} target="_blank" rel="noreferrer" sx={{ color: 'primary.main', textDecoration: 'none' }}>
                              {t.title}
                            </Typography>
                          ) : (
                            t.title
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip size="small" variant="outlined" label={agent?.spec.displayName ?? t.agentId} />
                        </TableCell>
                        <TableCell>
                          <StatusChip status={String(t.status)} />
                        </TableCell>
                        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>{t.requestedBy}</TableCell>
                        <TableCell>
                          <RelativeTime iso={t.startTime} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
          <Stack direction="row" sx={{ mt: 1, justifyContent: 'flex-end' }}>
            <Typography variant="caption" color="text.secondary">
              Refreshes every 10 s
            </Typography>
          </Stack>
        </Grid>
      </Grid>
    </>
  );
}
