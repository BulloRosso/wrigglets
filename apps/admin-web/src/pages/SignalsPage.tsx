import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DeleteOutline from '@mui/icons-material/DeleteOutlined';
import { EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import type { SignalsHubStatus } from '@cw/shared';
import { api } from '../api';

/*
 * Signals (optional module, ADR-0037) on the platform level: the connectors of the signals hub and their status.
 * Per-agent settings are on the agent's "Signals" tab; open loops are shown in each agent's UI.
 */

const STATE_COLOR = { up: 'success', down: 'error', connecting: 'warning', disabled: 'default' } as const;

const EXAMPLE = {
  imap: [{ id: 'office-mail', agentId: 'lara', host: 'greenmail', port: 3143, secure: false, user: 'office@sofaworks.test', passwordRef: 'signals-imap-office', mailbox: 'INBOX', pollSeconds: 30 }],
  mqtt: [{ id: 'plant', url: 'mqtt://mosquitto:1883', subscriptions: [{ topic: 'plant/+/alarm', agentId: 'max', debounceSeconds: 10, maxPerHour: 30, maxPayloadBytes: 4000 }] }],
};

function Status({ status }: { status: SignalsHubStatus | { error: string } }) {
  if ('error' in status) return <Alert severity="warning">The signals hub does not answer: {status.error}</Alert>;
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Chip size="small" label={`configuration ${status.configVersion ?? '—'}`} />
        <Chip size="small" color={status.outbox.pending ? 'warning' : 'default'} label={`outbox: ${status.outbox.pending} pending`} />
        <Chip size="small" color={status.outbox.failed ? 'error' : 'default'} label={`${status.outbox.failed} failed`} />
        {status.outbox.oldest && (
          <Typography variant="caption" color="text.secondary">
            oldest pending <RelativeTime iso={status.outbox.oldest} />
          </Typography>
        )}
      </Stack>
      {status.connectors.length === 0 ? (
        <EmptyState title="No connectors" text="Add an HTTP source below, or IMAP accounts and MQTT brokers in the connector configuration." />
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Connector</TableCell>
              <TableCell>Kind</TableCell>
              <TableCell>State</TableCell>
              <TableCell align="right">Observations</TableCell>
              <TableCell>Last</TableCell>
              <TableCell>Error</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {status.connectors.map((c) => (
              <TableRow key={`${c.kind}-${c.id}`}>
                <TableCell>{c.id}</TableCell>
                <TableCell>{c.kind}</TableCell>
                <TableCell>
                  <Chip size="small" color={STATE_COLOR[c.state]} label={c.state} />
                </TableCell>
                <TableCell align="right">{c.observations}</TableCell>
                <TableCell>{c.lastObservationAt ? <RelativeTime iso={c.lastObservationAt} /> : '—'}</TableCell>
                <TableCell sx={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.lastError ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}

export function SignalsPage() {
  const qc = useQueryClient();
  const available = useQuery({ queryKey: ['signals-available'], queryFn: api.signalsAvailable, staleTime: 60_000 });
  const overview = useQuery({ queryKey: ['signals-overview'], queryFn: api.signalsOverview, enabled: !!available.data?.available, refetchInterval: 10_000 });
  const agents = useQuery({ queryKey: ['agents', false], queryFn: () => api.agents(false) });
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState<string>();
  const [source, setSource] = useState({ id: '', agentId: '' });
  const [token, setToken] = useState<{ id: string; token: string }>();

  useEffect(() => {
    if (overview.data && !json) {
      const { imap, mqtt } = overview.data.connectors;
      setJson(JSON.stringify({ imap, mqtt }, null, 2));
    }
  }, [overview.data, json]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['signals-overview'] });
  const saveConnectors = useMutation({
    mutationFn: async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
        setJsonError(undefined);
      } catch (err) {
        setJsonError(String(err));
        throw new Error('The connector configuration is not valid JSON');
      }
      return api.saveSignalsConnectors(parsed as never);
    },
    onSuccess: refresh,
  });
  const createSource = useMutation({ mutationFn: () => api.createSignalsHttpSource(source.id.trim(), source.agentId), onSuccess: (t) => (setToken(t), setSource({ id: '', agentId: '' }), refresh()) });
  const deleteSource = useMutation({ mutationFn: api.deleteSignalsHttpSource, onSuccess: refresh });

  if (available.isLoading) return <Loading />;
  if (!available.data?.available) {
    return (
      <>
        <PageHeader title="Signals" subtitle="Proactive follow-up of incoming information and deadlines (optional module)." />
        <Alert severity="info">
          Signals is not configured on this platform. Start the stack with <code>docker-compose.signals.yml</code>; see docs/signals.md.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Signals"
        subtitle="Agents interpret incoming observations, keep track of what should follow and raise a signal when it is overdue. Connectors deliver the observations; each agent's Signals tab switches it on."
      />
      {overview.isLoading && <Loading />}
      <ErrorAlert error={overview.error} />
      {overview.data && (
        <Stack spacing={3}>
          <Card>
            <CardHeader title="Hub status" subheader={`Signals is on for: ${overview.data.agents.join(', ') || 'no agent yet (switch it on in an agent’s Signals tab)'}`} />
            <CardContent>
              <Status status={overview.data.status} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="HTTP sources" subheader="Systems post observations to the hub: POST /observations with the source's bearer token. The source decides which agent receives them." />
            <CardContent>
              <Stack spacing={2}>
                {overview.data.connectors.http.map((s) => (
                  <Stack key={s.id} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                    <Typography sx={{ minWidth: 160 }}>{s.id}</Typography>
                    <Typography color="text.secondary">→ {s.agentId}</Typography>
                    <IconButton aria-label={`delete ${s.id}`} onClick={() => deleteSource.mutate(s.id)}>
                      <DeleteOutline />
                    </IconButton>
                  </Stack>
                ))}
                {token && (
                  <Alert severity="warning" onClose={() => setToken(undefined)}>
                    Token of <b>{token.id}</b> (shown once): <code>{token.token}</code>
                  </Alert>
                )}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField label="Source id" value={source.id} onChange={(e) => setSource({ ...source, id: e.target.value })} placeholder="erp-events" />
                  <TextField select label="Agent" value={source.agentId} onChange={(e) => setSource({ ...source, agentId: e.target.value })} sx={{ minWidth: 200 }}>
                    {(agents.data ?? []).map((a) => (
                      <MenuItem key={a.spec.agentId} value={a.spec.agentId}>
                        {a.spec.displayName}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button onClick={() => createSource.mutate()} disabled={!/^[a-z][a-z0-9-]{1,30}$/.test(source.id.trim()) || !source.agentId || createSource.isPending}>
                    Create
                  </Button>
                </Stack>
                <ErrorAlert error={createSource.error ?? deleteSource.error} />
              </Stack>
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title="IMAP accounts and MQTT brokers"
              subheader="Passwords are Key Vault secret names (Safety & tools → Secrets); the hub reads them, agents never see them."
              action={
                <Button size="small" onClick={() => setJson(JSON.stringify(EXAMPLE, null, 2))}>
                  Insert example
                </Button>
              }
            />
            <CardContent>
              <Stack spacing={2}>
                <TextField
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  multiline
                  minRows={10}
                  error={!!jsonError}
                  helperText={jsonError ?? 'imap[]: id, agentId, host, port, secure, user, passwordRef, mailbox, moveTo?, pollSeconds · mqtt[]: id, url, username?, passwordRef?, subscriptions[]: topic, agentId, debounceSeconds, maxPerHour, maxPayloadBytes'}
                  slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } } }}
                />
                <ErrorAlert error={saveConnectors.error} />
                {saveConnectors.isSuccess && <Alert severity="success">Saved. The hub picks it up within 10 seconds.</Alert>}
                <Button variant="contained" sx={{ alignSelf: 'flex-start' }} onClick={() => saveConnectors.mutate()} disabled={saveConnectors.isPending}>
                  Save connectors
                </Button>
              </Stack>
            </CardContent>
          </Card>
        </Stack>
      )}
    </>
  );
}
