import { useEffect, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
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
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import { EmptyState, ErrorAlert, KeyValueList, Loading, PageHeader, formatDateTime } from '@cw/ui';
import type { DerivedExpectation, ExpectationState, InterpretResult, ObservationInput, SignalAction } from '@cw/shared';
import { api } from '../api';

/*
 * Signals (optional module, ADR-0037): what this agent noticed and what it keeps track of.
 *   Open loops    – expectations with due date; people can change the due date or action, mark them fulfilled or dismiss them
 *   Observations  – what came in and what came of it (zero events is a valid result)
 *   Playground    – interpret a text, review and edit the result, then commit it
 */

const STATE_COLOR: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = { open: 'info', signalled: 'warning', fulfilled: 'success', dismissed: 'default', expired: 'error' };
const ACTION_LABEL: Record<SignalAction, string> = { notify: 'notify people', propose_task: 'propose a follow-up task' };

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => new Date(v).toISOString();

/* ================================================================================ open loops */

function ExpectationDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['expectation', id], queryFn: () => api.expectation(id), refetchInterval: 10_000 });
  const [due, setDue] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (q.data) setDue(toLocalInput(q.data.dueAt));
  }, [q.data]);
  const done = (st: ExpectationState) => {
    qc.setQueryData(['expectation', id], st);
    void qc.invalidateQueries({ queryKey: ['expectations'] });
    setReason('');
  };
  const edit = useMutation({ mutationFn: (body: Parameters<typeof api.editExpectation>[1]) => api.editExpectation(id, body), onSuccess: done });
  const resolve = useMutation({ mutationFn: (kind: 'dismiss' | 'fulfill') => api.resolveExpectation(id, kind, reason.trim()), onSuccess: done });
  const e = q.data;
  const open = e && (e.state === 'open' || e.state === 'signalled');

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{e?.title ?? 'Expectation'}</DialogTitle>
      <DialogContent>
        {q.isLoading && <Loading />}
        <ErrorAlert error={q.error ?? edit.error ?? resolve.error} />
        {e && (
          <Stack spacing={2}>
            <KeyValueList
              items={[
                ['State', <Chip key="s" size="small" color={STATE_COLOR[e.state]} label={e.state} />],
                ['Due', formatDateTime(e.dueAt)],
                ['When overdue', ACTION_LABEL[e.action]],
                ['Why', e.description || '–'],
                ['Recognised by', e.matchHint || '–'],
                ['Origin', `${e.source.kind}${e.source.subject ? ` · "${e.source.subject}"` : ''}${e.source.events.length ? ` · ${e.source.events.join('; ')}` : ''}`],
                ...(e.signal
                  ? ([
                      [
                        'Signal',
                        <span key="sig">
                          {formatDateTime(e.signal.at)} · {ACTION_LABEL[e.signal.action]}
                          {e.signal.taskId && (
                            <>
                              {' · '}
                              <Link component={RouterLink} to={`/tasks/${encodeURIComponent(e.signal.taskId)}`}>
                                follow-up task
                              </Link>
                            </>
                          )}
                          {e.signal.error && ` · error: ${e.signal.error}`}
                        </span>,
                      ],
                    ] as Array<[string, React.ReactNode]>)
                  : []),
                ...(e.resolution ? ([['Resolution', `${e.resolution.by}: ${e.resolution.reason}`]] as Array<[string, React.ReactNode]>) : []),
              ]}
            />
            {open && (
              <Card variant="outlined">
                <CardContent>
                  <Stack spacing={2}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
                      <TextField type="datetime-local" label="Due" value={due} onChange={(ev) => setDue(ev.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
                      <Button onClick={() => edit.mutate({ dueAt: fromLocalInput(due) })} disabled={!due || edit.isPending || toLocalInput(e.dueAt) === due}>
                        Change due date
                      </Button>
                      <TextField select label="When overdue" value={e.action} onChange={(ev) => edit.mutate({ action: ev.target.value as SignalAction })} sx={{ minWidth: 240 }}>
                        <MenuItem value="propose_task">{ACTION_LABEL.propose_task}</MenuItem>
                        <MenuItem value="notify">{ACTION_LABEL.notify}</MenuItem>
                      </TextField>
                    </Stack>
                    <TextField label="Reason" value={reason} onChange={(ev) => setReason(ev.target.value)} helperText="Required to close it. Dismissal reasons teach the agent what not to track." />
                    <Stack direction="row" spacing={1}>
                      <Button color="success" variant="contained" onClick={() => resolve.mutate('fulfill')} disabled={!reason.trim() || resolve.isPending}>
                        Mark as fulfilled
                      </Button>
                      <Button color="inherit" onClick={() => resolve.mutate('dismiss')} disabled={!reason.trim() || resolve.isPending}>
                        Dismiss
                      </Button>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            )}
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                History
              </Typography>
              {e.history.map((h, i) => (
                <Typography key={i} variant="body2" color="text.secondary">
                  {formatDateTime(h.at)} · {h.kind}
                  {h.by ? ` · ${h.by}` : ''}
                  {h.text ? ` · ${h.text}` : ''}
                </Typography>
              ))}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function OpenLoops() {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [params, setParams] = useSearchParams();
  const selected = params.get('expectation');
  const q = useQuery({ queryKey: ['expectations', status], queryFn: () => api.expectations(status), refetchInterval: 10_000 });
  const select = (id?: string) => setParams(id ? { expectation: id } : {});
  return (
    <Stack spacing={2}>
      <ToggleButtonGroup size="small" exclusive value={status} onChange={(_e, v) => v && setStatus(v)}>
        <ToggleButton value="open">Open</ToggleButton>
        <ToggleButton value="closed">Closed</ToggleButton>
      </ToggleButtonGroup>
      {q.isLoading && <Loading />}
      <ErrorAlert error={q.error} />
      {q.data && q.data.length === 0 && (
        <EmptyState title={status === 'open' ? 'No open loops' : 'Nothing closed yet'} text="Expectations appear when an observation implies that something should follow." />
      )}
      {q.data && q.data.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Expected</TableCell>
              <TableCell>Due</TableCell>
              <TableCell>State</TableCell>
              <TableCell>Source</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {q.data.map((e) => (
              <TableRow key={e.id} hover sx={{ cursor: 'pointer' }} onClick={() => select(e.id)}>
                <TableCell>{e.title}</TableCell>
                <TableCell>{e.dueAt ? formatDateTime(e.dueAt) : '–'}</TableCell>
                <TableCell>
                  <Chip size="small" color={STATE_COLOR[e.state] ?? 'default'} label={e.state} />
                </TableCell>
                <TableCell>{e.source ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {selected && <ExpectationDialog id={selected} onClose={() => select()} />}
    </Stack>
  );
}

/* ================================================================================ observations */

function Observations() {
  const q = useQuery({ queryKey: ['observations'], queryFn: api.observations, refetchInterval: 10_000 });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  if (!q.data.length) return <EmptyState title="No observations yet" text="Mails, messages and reports of agents appear here once they were interpreted." />;
  return (
    <Stack spacing={1.5}>
      {q.data.map((o) => (
        <Card key={o.id} variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 1 }}>
              <Chip size="small" label={o.source} />
              <Typography variant="subtitle2">{o.subject || o.excerpt.slice(0, 80)}</Typography>
              <Typography variant="caption" color="text.secondary">
                {formatDateTime(o.at)}
                {o.from ? ` · ${o.from}` : ''}
              </Typography>
            </Stack>
            {o.error ? (
              <Alert severity="error">{o.error}</Alert>
            ) : o.events.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No events{o.note ? ` — ${o.note}` : ''}. Zero events can be the right result.
              </Typography>
            ) : (
              <Stack spacing={0.5}>
                {o.events.map((ev, i) => (
                  <Typography key={i} variant="body2">
                    ⚡ <b>{ev.type}</b> — {ev.summary}
                  </Typography>
                ))}
              </Stack>
            )}
            {(o.created.length > 0 || o.fulfilled.length > 0) && (
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
                {o.created.map((id) => (
                  <Chip key={id} size="small" color="info" variant="outlined" label="new expectation" component={RouterLink} to={`/signals?expectation=${encodeURIComponent(id)}`} clickable />
                ))}
                {o.fulfilled.map((f) => (
                  <Chip key={f.expectationId} size="small" color="success" variant="outlined" label={`fulfilled: ${f.reason.slice(0, 60)}`} component={RouterLink} to={`/signals?expectation=${encodeURIComponent(f.expectationId)}`} clickable />
                ))}
              </Stack>
            )}
            {o.skipped && (
              <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 1 }}>
                Not tracked: {o.skipped}
              </Typography>
            )}
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

/* ================================================================================ playground */

const SCENARIOS: Array<{ key: string; label: string; subject: string; from: string; body: string }> = [
  {
    key: 'hotel',
    label: '🏨 Hotel',
    subject: 'Your booking confirmation',
    from: 'reservations@hotel-nordlicht.example',
    body: 'Good day,\n\nthank you for booking with Hotel Nordlicht. Your stay from 18 to 20 November is confirmed. You will receive the invoice after your departure.\n\nKind regards\nYour hotel team',
  },
  {
    key: 'invoice',
    label: '🧾 Invoice',
    subject: 'Invoice 2026-1187 for your stay',
    from: 'billing@hotel-nordlicht.example',
    body: 'Good day,\n\nplease find attached the invoice for your stay from 18 to 20 November. Amount: EUR 412.00, payable within 14 days to the account stated on the invoice.\n\nKind regards\nHotel Nordlicht, accounting',
  },
  {
    key: 'customer',
    label: '🤝 Customer',
    subject: 'Re: Offer for 40 lounge sofas',
    from: 'purchasing@cafe-hafenblick.example',
    body: 'Hello,\n\nthank you for the offer. We will discuss it internally and get back to you by Friday.\n\nBest regards\nMara Lindqvist, Café Hafenblick',
  },
  {
    key: 'newsletter',
    label: '🍜 Newsletter',
    subject: 'Ramen of the week',
    from: 'news@noodlebar.example',
    body: 'This week at Noodle Bar Mitte: spicy miso ramen with roasted corn. 10 % off with the code MISO10 until Sunday.\n\nYou receive this newsletter because you signed up. Unsubscribe here.',
  },
];

function ExpectationEditor({ e, onChange, onRemove }: { e: DerivedExpectation; onChange: (e: DerivedExpectation) => void; onRemove: () => void }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField label="Expected" value={e.title} onChange={(ev) => onChange({ ...e, title: ev.target.value })} fullWidth size="small" />
            <IconButton aria-label="remove expectation" onClick={onRemove}>
              <DeleteOutlined />
            </IconButton>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              type="datetime-local"
              label="Due"
              size="small"
              value={toLocalInput(e.dueAt)}
              onChange={(ev) => ev.target.value && onChange({ ...e, dueAt: fromLocalInput(ev.target.value) })}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField select size="small" label="When overdue" value={e.action ?? 'propose_task'} onChange={(ev) => onChange({ ...e, action: ev.target.value as SignalAction })} sx={{ minWidth: 240 }}>
              <MenuItem value="propose_task">{ACTION_LABEL.propose_task}</MenuItem>
              <MenuItem value="notify">{ACTION_LABEL.notify}</MenuItem>
            </TextField>
          </Stack>
          <TextField label="Recognised by" size="small" value={e.matchHint} onChange={(ev) => onChange({ ...e, matchHint: ev.target.value })} />
          <TextField label="Why / what to do" size="small" value={e.description} onChange={(ev) => onChange({ ...e, description: ev.target.value })} multiline />
        </Stack>
      </CardContent>
    </Card>
  );
}

function Playground({ brief }: { brief: string }) {
  const qc = useQueryClient();
  const [scenario, setScenario] = useState(SCENARIOS[0]!.key);
  const [context, setContext] = useState(brief);
  const [mail, setMail] = useState({ subject: SCENARIOS[0]!.subject, from: SCENARIOS[0]!.from, body: SCENARIOS[0]!.body });
  const [result, setResult] = useState<InterpretResult & { model?: string; costUsd?: number }>();
  const observation: ObservationInput = { source: 'playground', subject: mail.subject || undefined, from: mail.from || undefined, body: mail.body };
  const interpret = useMutation({ mutationFn: () => api.interpret(observation, context), onSuccess: setResult });
  const commit = useMutation({
    mutationFn: () => api.commitObservation(observation, result!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['observations'] });
      void qc.invalidateQueries({ queryKey: ['expectations'] });
    },
  });
  const pick = (key: string) => {
    const s = SCENARIOS.find((x) => x.key === key)!;
    setScenario(key);
    setMail({ subject: s.subject, from: s.from, body: s.body });
    setResult(undefined);
    commit.reset();
  };

  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card>
          <CardHeader title="01 · Incoming observation" subheader="Pick a scenario, change the text and see what the agent derives from it." />
          <CardContent>
            <Stack spacing={2}>
              <ToggleButtonGroup size="small" exclusive value={scenario} onChange={(_e, v) => v && pick(v)} sx={{ flexWrap: 'wrap' }}>
                {SCENARIOS.map((s) => (
                  <ToggleButton key={s.key} value={s.key}>
                    {s.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <TextField label="Role / context (brief)" value={context} onChange={(e) => setContext(e.target.value)} multiline minRows={3} helperText="Only for this trial; the saved brief is set in the admin console." />
              <TextField label="From" value={mail.from} onChange={(e) => setMail({ ...mail, from: e.target.value })} size="small" />
              <TextField label="Subject" value={mail.subject} onChange={(e) => setMail({ ...mail, subject: e.target.value })} size="small" />
              <TextField label="Text" value={mail.body} onChange={(e) => setMail({ ...mail, body: e.target.value })} multiline minRows={6} />
              <ErrorAlert error={interpret.error} />
              <Button variant="contained" onClick={() => interpret.mutate()} disabled={interpret.isPending || !mail.body.trim()} sx={{ alignSelf: 'flex-start' }}>
                {interpret.isPending ? 'Interpreting…' : 'Interpret now'}
              </Button>
              <Typography variant="caption" color="text.secondary">
                Uses the agent's own model (counted in its spend limit). Nothing is stored until you commit the result.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card>
          <CardHeader title="02 · Interpretation" subheader={result?.model ? `${result.model}${result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(4)}` : ''}` : 'Events and expectations; you can edit them before committing.'} />
          <CardContent>
            {!result ? (
              <EmptyState title="The agent is watching." text={'Click "Interpret now". Zero events can be a correct result too.'} />
            ) : (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Events ({result.events.length})
                  </Typography>
                  {result.events.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      No events{result.note ? ` — ${result.note}` : ''}.
                    </Typography>
                  )}
                  {result.events.map((ev, i) => (
                    <Typography key={i} variant="body2">
                      ⚡ <b>{ev.type}</b> — {ev.summary}
                    </Typography>
                  ))}
                </Box>
                {result.fulfills.length > 0 && (
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>
                      Fulfils open expectations
                    </Typography>
                    {result.fulfills.map((f) => (
                      <Typography key={f.expectationId} variant="body2">
                        ✅ {f.expectationId} ({Math.round(f.confidence * 100)} %) — {f.reason}
                      </Typography>
                    ))}
                  </Box>
                )}
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Expectations ({result.expectations.length})
                  </Typography>
                  <Stack spacing={1.5}>
                    {result.expectations.map((e, i) => (
                      <ExpectationEditor
                        key={i}
                        e={e}
                        onChange={(next) => setResult({ ...result, expectations: result.expectations.map((x, j) => (j === i ? next : x)) })}
                        onRemove={() => setResult({ ...result, expectations: result.expectations.filter((_x, j) => j !== i) })}
                      />
                    ))}
                  </Stack>
                </Box>
                <ErrorAlert error={commit.error} />
                {commit.data && (
                  <Alert severity={commit.data.duplicate ? 'info' : 'success'}>
                    {commit.data.duplicate ? 'This observation was committed before.' : 'Committed: the expectations are now tracked under Open loops.'}
                  </Alert>
                )}
                <Button variant="contained" onClick={() => commit.mutate()} disabled={commit.isPending || !!commit.data} sx={{ alignSelf: 'flex-start' }}>
                  Commit and track
                </Button>
              </Stack>
            )}
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}

/* ================================================================================ page */

export function SignalsPage() {
  const info = useQuery({ queryKey: ['signals'], queryFn: api.signals, staleTime: 30_000 });
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'loops' | 'observations' | 'playground'>('loops');
  useEffect(() => {
    if (params.get('expectation')) setTab('loops');
  }, [params]);
  if (info.isLoading) return <Loading />;
  if (!info.data) return <ErrorAlert error={info.error} />;
  return (
    <>
      <PageHeader
        title="Signals"
        subtitle="What came in, what should follow from it, and what is overdue. A good agent completes a task; Signals notices that there is one."
      />
      {!info.data.enabled && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Signals is switched off for this agent. An administrator can switch it on in the admin console (agent → Signals). Existing expectations stay visible.
        </Alert>
      )}
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 3 }}>
        <Tab value="loops" label="Open loops" />
        <Tab value="observations" label="Observations" />
        <Tab value="playground" label="Playground" disabled={!info.data.enabled} />
      </Tabs>
      {tab === 'loops' && <OpenLoops />}
      {tab === 'observations' && <Observations />}
      {tab === 'playground' && <Playground brief={info.data.brief} />}
    </>
  );
}
