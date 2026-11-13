import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { DEFAULT_SIGNALS_BRIEF, type AgentSummary, type SignalsAgentConfig } from '@cw/shared';
import { ErrorAlert, Loading } from '@cw/ui';
import { api } from '../api';

/*
 * Signals settings of one agent (optional module, ADR-0037): switched on/off, the brief the interpreter works with
 * (role, goals and limits — no process rules), the person follow-up tasks are started for, the default action and the
 * thresholds. A test observation goes through the same path as one from the hub.
 */

export function SignalsTab({ a }: { a: AgentSummary }) {
  const qc = useQueryClient();
  const agentId = a.spec.agentId;
  const q = useQuery({ queryKey: ['agent-signals', agentId], queryFn: () => api.agentSignals(agentId) });
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, staleTime: 60_000 });
  const [f, setF] = useState<SignalsAgentConfig | undefined>();
  const [test, setTest] = useState({ subject: 'Your booking confirmation', body: 'Thank you for booking with Hotel Nordlicht. Your stay from 18 to 20 November is confirmed. You will receive the invoice after your departure.' });
  useEffect(() => {
    if (q.data) setF(q.data.config);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (c: SignalsAgentConfig) => api.setAgentSignals(agentId, c),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agent-signals', agentId] }),
  });
  const send = useMutation({ mutationFn: () => api.sendObservation(agentId, { source: 'api', subject: test.subject, body: test.body }) });

  if (q.isLoading || !f) return q.error ? <ErrorAlert error={q.error} /> : <Loading />;
  if (!q.data!.available) {
    return (
      <Alert severity="info">
        Signals is an optional module and is not configured on this platform. Start the stack with <code>docker-compose.signals.yml</code> (sets <code>SIGNALS_HUB_URL</code>{' '}
        and <code>SIGNALS_HUB_TOKEN</code> on the control plane) to let agents notice open loops in incoming mails and messages. See docs/signals.md.
      </Alert>
    );
  }
  const candidates = (users.data ?? []).filter((u) => !u.disabled && ((u.agentRoles[agentId]?.length ?? 0) > 0 || (u.agentRoles['*']?.length ?? 0) > 0));
  const set = <K extends keyof SignalsAgentConfig>(k: K, v: SignalsAgentConfig[K]) => setF({ ...f, [k]: v });

  return (
    <Stack spacing={2}>
      <Card>
        <CardHeader
          title="Signals"
          subheader="Proactive follow-up: the agent interprets incoming observations, keeps track of what should follow and raises a signal when it is overdue."
          action={<Chip size="small" color={q.data!.config.enabled ? 'success' : 'default'} label={q.data!.config.enabled ? 'on' : 'off'} />}
        />
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" sx={{ alignItems: 'center' }}>
              <Switch checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              <Typography variant="body2">Signals for {a.spec.displayName}</Typography>
            </Stack>
            <TextField
              label="Brief: role, goals and limits"
              value={f.brief}
              onChange={(e) => set('brief', e.target.value)}
              multiline
              minRows={4}
              helperText="Added to the agent's AGENTS.md for the interpretation. Describe the role and the limits, not process rules."
            />
            <Button size="small" sx={{ alignSelf: 'flex-start' }} onClick={() => set('brief', DEFAULT_SIGNALS_BRIEF)} disabled={f.brief === DEFAULT_SIGNALS_BRIEF}>
              Reset to the default brief
            </Button>
            <TextField
              select
              label="Follow-up tasks are requested for"
              value={f.owner?.upn ?? ''}
              onChange={(e) => {
                const u = candidates.find((c) => c.email === e.target.value);
                set('owner', u ? { upn: u.email, name: u.name, oid: u.id } : undefined);
              }}
              helperText="This person receives the inbox notice and counts as requester. Approvers of the agent can always decide on the plan."
            >
              <MenuItem value="">(nobody: the platform identity "Signals")</MenuItem>
              {candidates.map((u) => (
                <MenuItem key={u.id} value={u.email}>
                  {u.name} ({u.email})
                </MenuItem>
              ))}
            </TextField>
            <TextField select label="When an expectation is overdue (default)" value={f.defaultAction} onChange={(e) => set('defaultAction', e.target.value as SignalsAgentConfig['defaultAction'])}>
              <MenuItem value="propose_task">Propose a follow-up task (a person approves its plan)</MenuItem>
              <MenuItem value="notify">Notify the people with access to the agent</MenuItem>
            </TextField>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                type="number"
                label="Fulfilment confidence"
                value={f.fulfilThreshold}
                onChange={(e) => set('fulfilThreshold', Number(e.target.value))}
                slotProps={{ htmlInput: { min: 0.5, max: 1, step: 0.05 } }}
                helperText="0.5–1: from here a matching observation closes an expectation."
              />
              <TextField type="number" label="Observations per hour" value={f.maxObservationsPerHour} onChange={(e) => set('maxObservationsPerHour', Number(e.target.value))} slotProps={{ htmlInput: { min: 1, max: 1000 } }} />
              <TextField type="number" label="Grace days after a signal" value={f.graceDays} onChange={(e) => set('graceDays', Number(e.target.value))} slotProps={{ htmlInput: { min: 1, max: 365 } }} />
              <TextField label="Model (optional)" value={f.model} onChange={(e) => set('model', e.target.value)} placeholder="agent's small model" />
            </Stack>
            <ErrorAlert error={save.error} />
            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={() => save.mutate(f)} disabled={save.isPending}>
                Save
              </Button>
              <Button onClick={() => setF(q.data!.config)}>Discard changes</Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Test observation" subheader="Hand in a mail-like observation by hand; it takes the same path as one from the signals hub." />
        <CardContent>
          <Stack spacing={2}>
            <TextField label="Subject" value={test.subject} onChange={(e) => setTest({ ...test, subject: e.target.value })} />
            <TextField label="Text" value={test.body} onChange={(e) => setTest({ ...test, body: e.target.value })} multiline minRows={3} />
            <ErrorAlert error={send.error} />
            {send.data && (
              <Alert severity={send.data.duplicate ? 'info' : 'success'}>
                {send.data.duplicate ? 'This observation was handed in before.' : 'Handed in.'} Follow it in the agent UI under Signals ({send.data.observationId}).
              </Alert>
            )}
            <Button sx={{ alignSelf: 'flex-start' }} onClick={() => send.mutate()} disabled={send.isPending || !q.data!.config.enabled || !test.body.trim()}>
              Send to {a.spec.displayName}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
