import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { AgentPortrait, EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime, formatDateTime } from '@cw/ui';
import { api, avatarSrc, type MailRecord } from '../api';

const STATUS_COLOR = { sent: 'success', written: 'info', failed: 'error' } as const;
const STATUS_LABEL = { sent: 'sent via API', written: 'outbox file', failed: 'delivery failed' } as const;

/** What agents sent to people (approval requests), with the stored HTML as preview — ADR-0026. */
export function MailPage() {
  const agents = useQuery({ queryKey: ['agents', false], queryFn: () => api.agents(false) });
  const [agentId, setAgentId] = useState('');
  const q = useQuery({ queryKey: ['mail', agentId], queryFn: () => api.mails(agentId || undefined), refetchInterval: 10_000 });
  const [selected, setSelected] = useState<MailRecord>();
  useEffect(() => {
    if (q.data && (!selected || !q.data.mails.some((m) => m.id === selected.id))) setSelected(q.data.mails[0]);
  }, [q.data, selected]);

  return (
    <>
      <PageHeader
        title="Mail outbox"
        subtitle="E-mails agents send to people, e.g. to ask for a decision. Each mail is kept as HTML for review."
        actions={
          <TextField
            select
            size="small"
            label="Agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            sx={{ minWidth: 200 }}
            slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
          >
            <MenuItem value="">All agents</MenuItem>
            {agents.data?.map((a) => (
              <MenuItem key={a.spec.agentId} value={a.spec.agentId}>
                {a.spec.displayName}
              </MenuItem>
            ))}
          </TextField>
        }
      />
      {q.data && (
        <Alert severity="info" sx={{ mb: 3 }}>
          {q.data.delivery === 'api'
            ? 'Delivery: mails are posted to the configured mail API (MAIL_API_URL) and also kept here.'
            : 'Delivery: no mail API configured — mails are only written to the outbox (mail_out on the control-plane volume). Set MAIL_API_URL to deliver them.'}
        </Alert>
      )}
      <ErrorAlert error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.mails.length ? (
        <EmptyState title="No mails yet" text="Agents write a mail when a task waits for an approval." />
      ) : (
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Agent</TableCell>
                    <TableCell>Subject</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {q.data.mails.map((m) => (
                    <TableRow key={m.id} hover selected={selected?.id === m.id} onClick={() => setSelected(m)} sx={{ cursor: 'pointer' }}>
                      <TableCell>
                        <AgentPortrait src={avatarSrc(m.agentId)} name={m.agentName} size={32} />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{m.subject}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          <RelativeTime iso={m.at} /> · {m.to.length} recipient(s)
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip size="small" variant="outlined" color={STATUS_COLOR[m.status]} label={STATUS_LABEL[m.status]} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, lg: 7 }}>
            {selected && (
              <Card>
                <CardHeader title={selected.subject} subheader={`${formatDateTime(selected.at)} · from ${selected.agentName} · task ${selected.taskId ?? '–'}`} />
                <CardContent sx={{ pt: 0 }}>
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    <b>To:</b> {selected.to.length ? selected.to.join(', ') : '(nobody has access to this agent)'}
                  </Typography>
                  {selected.error && (
                    <Alert severity="error" sx={{ mb: 2 }}>
                      {selected.error}
                    </Alert>
                  )}
                  <Box
                    component="iframe"
                    title={`Mail ${selected.id}`}
                    src={api.mailHtmlUrl(selected.id)}
                    sandbox=""
                    sx={{ width: '100%', height: '65vh', border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: '#f4f6fa' }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    Preview of the stored HTML (links are disabled here). File: mail_out/{selected.id}.html
                  </Typography>
                </CardContent>
              </Card>
            )}
          </Grid>
        </Grid>
      )}
    </>
  );
}
