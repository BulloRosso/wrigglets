import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActions from '@mui/material/CardActions';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddOutlined from '@mui/icons-material/AddOutlined';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import DeleteOutline from '@mui/icons-material/DeleteOutlined';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import SettingsSuggestOutlined from '@mui/icons-material/SettingsSuggestOutlined';
import { SCHEDULE_TIMEZONE, describeCalendar, type ApprovalPolicy, type CalendarSpec, type ScheduleDto } from '@cw/shared';
import { ConfirmDialog, EmptyState, ErrorAlert, KeyValueList, Loading, PageHeader, formatDateTime } from '@cw/ui';
import { api, hasRole, useMe } from '../api';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface FormState {
  title: string;
  instructions: string;
  type: 'analysis' | 'report' | 'change';
  approval: ApprovalPolicy;
  kind: CalendarSpec['kind'];
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  cron: string;
  at: string;
}

const emptyForm = (): FormState => ({ title: '', instructions: '', type: 'report', approval: 'deviation', kind: 'monthly', time: '07:00', dayOfWeek: 1, dayOfMonth: 1, cron: '0 7 1 * *', at: '' });

function toCalendar(f: FormState): CalendarSpec {
  const [hour, minute] = f.time.split(':').map(Number) as [number, number];
  switch (f.kind) {
    case 'daily':
      return { kind: 'daily', hour, minute };
    case 'weekly':
      return { kind: 'weekly', dayOfWeek: f.dayOfWeek, hour, minute };
    case 'monthly':
      return { kind: 'monthly', dayOfMonth: f.dayOfMonth, hour, minute };
    case 'cron':
      return { kind: 'cron', cron: f.cron };
    case 'once':
      return { kind: 'once', at: new Date(f.at).toISOString() };
  }
}

function fromSchedule(s: ScheduleDto): FormState {
  const f = emptyForm();
  f.title = s.title;
  f.instructions = s.instructions ?? '';
  f.type = (s.type as FormState['type']) ?? 'report';
  f.approval = (s.approval as ApprovalPolicy) ?? 'deviation';
  const c = s.calendar;
  if (c) {
    f.kind = c.kind;
    if ('hour' in c) f.time = `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
    if (c.kind === 'weekly') f.dayOfWeek = c.dayOfWeek;
    if (c.kind === 'monthly') f.dayOfMonth = c.dayOfMonth;
    if (c.kind === 'cron') f.cron = c.cron;
  }
  return f;
}

function ScheduleDialog({ open, initial, scheduleId, onClose }: { open: boolean; initial?: FormState; scheduleId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(initial ?? emptyForm());
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: async () => {
      const calendar = toCalendar(f);
      if (scheduleId) await api.patchSchedule(scheduleId, { title: f.title, instructions: f.instructions, approval: f.approval, calendar });
      else await api.createSchedule({ title: f.title, instructions: f.instructions, type: f.type, approval: f.approval, calendar });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] });
      onClose();
    },
  });
  const valid = f.title.trim().length >= 3 && f.instructions.trim() && (f.kind !== 'once' || f.at) && (f.kind !== 'cron' || f.cron.trim().split(/\s+/).length === 5);
  let preview = '';
  try {
    preview = describeCalendar(toCalendar(f));
  } catch {
    preview = '';
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{scheduleId ? 'Edit schedule' : 'New schedule'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField label="Title" required value={f.title} onChange={(e) => set('title', e.target.value)} />
          <TextField label="Instructions" required multiline minRows={4} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} />
          <Stack direction="row" spacing={2}>
            <TextField select label="Type" value={f.type} onChange={(e) => set('type', e.target.value as FormState['type'])} disabled={!!scheduleId} sx={{ flex: 1 }}>
              <MenuItem value="analysis">Analysis</MenuItem>
              <MenuItem value="report">Report</MenuItem>
              <MenuItem value="change">Change</MenuItem>
            </TextField>
            <TextField select label="Approval" value={f.approval} onChange={(e) => set('approval', e.target.value as ApprovalPolicy)} sx={{ flex: 1 }}>
              <MenuItem value="deviation">Only on deviations</MenuItem>
              <MenuItem value="plan">Approve plan first</MenuItem>
              <MenuItem value="none">No approval</MenuItem>
            </TextField>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label="Repeat" value={f.kind} onChange={(e) => set('kind', e.target.value as CalendarSpec['kind'])} sx={{ minWidth: 150 }}>
              <MenuItem value="daily">Daily</MenuItem>
              <MenuItem value="weekly">Weekly</MenuItem>
              <MenuItem value="monthly">Monthly</MenuItem>
              <MenuItem value="cron">Custom (cron)</MenuItem>
              <MenuItem value="once">Once</MenuItem>
            </TextField>
            {f.kind === 'weekly' && (
              <TextField select label="Day" value={f.dayOfWeek} onChange={(e) => set('dayOfWeek', Number(e.target.value))}>
                {DAYS.map((d, i) => (
                  <MenuItem key={d} value={i}>
                    {d}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {f.kind === 'monthly' && <TextField type="number" label="Day of month" value={f.dayOfMonth} onChange={(e) => set('dayOfMonth', Math.min(28, Math.max(1, Number(e.target.value))))} slotProps={{ htmlInput: { min: 1, max: 28 } }} />}
            {(f.kind === 'daily' || f.kind === 'weekly' || f.kind === 'monthly') && <TextField type="time" label="Time" value={f.time} onChange={(e) => set('time', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />}
            {f.kind === 'cron' && <TextField label="Cron expression" value={f.cron} onChange={(e) => set('cron', e.target.value)} helperText="minute hour day month weekday" />}
            {f.kind === 'once' && <TextField type="datetime-local" label="Run at" value={f.at} onChange={(e) => set('at', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {preview} · time zone {f.kind === 'once' ? 'your local time' : SCHEDULE_TIMEZONE}
          </Typography>
          <ErrorAlert error={save.error} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {scheduleId ? 'Save' : 'Create schedule'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ScheduleCard({ s }: { s: ScheduleDto }) {
  const qc = useQueryClient();
  const me = useMe();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [history, setHistory] = useState(false);
  const isAdmin = hasRole(me.data, 'admin');
  const mayEdit = isAdmin || (!s.system && s.owner?.upn === me.data?.user.upn);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['schedules'] });
  const pause = useMutation({ mutationFn: (paused: boolean) => api.patchSchedule(s.scheduleId, { paused }), onSuccess: invalidate });
  const trigger = useMutation({ mutationFn: () => api.triggerSchedule(s.scheduleId), onSuccess: () => setTimeout(invalidate, 1500) });
  const del = useMutation({ mutationFn: () => api.deleteSchedule(s.scheduleId), onSuccess: invalidate });

  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardHeader
        avatar={s.system ? <SettingsSuggestOutlined color="action" /> : undefined}
        title={s.title}
        subheader={s.calendar ? describeCalendar(s.calendar) : s.cron?.join(', ')}
        action={<FormControlLabel control={<Switch checked={!s.paused} disabled={!mayEdit || pause.isPending} onChange={(e) => pause.mutate(!e.target.checked)} />} label={s.paused ? 'Paused' : 'Active'} />}
      />
      <CardContent sx={{ flexGrow: 1, pt: 0 }}>
        <KeyValueList
          dense
          items={[
            ['Next runs', s.paused ? 'paused' : s.nextRuns.slice(0, 3).map(formatDateTime).join(' · ') || '–'],
            ['Owner', s.system ? 'system' : (s.owner?.name ?? s.owner?.upn ?? '–')],
            ['Type / approval', `${s.type}${s.approval ? ` · ${s.approval}` : ''}`],
            ['Time zone', s.timezone],
            [
              'Recent runs',
              s.recentRuns.length ? (
                <Stack spacing={0.25}>
                  {s.recentRuns.slice(0, 3).map((r) =>
                    r.workflowId.startsWith('task-') ? (
                      <Link key={r.workflowId} component={RouterLink} to={`/tasks/${encodeURIComponent(r.workflowId)}`} variant="body2">
                        {formatDateTime(r.startedAt)}
                      </Link>
                    ) : (
                      <span key={r.workflowId}>{formatDateTime(r.startedAt)}</span>
                    ),
                  )}
                </Stack>
              ) : (
                '–'
              ),
            ],
          ]}
        />
        <Collapse in={history}>
          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            Change history
          </Typography>
          {s.history.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No changes recorded.
            </Typography>
          ) : (
            s.history.map((h, i) => (
              <Typography key={i} variant="body2" color="text.secondary">
                {formatDateTime(h.at)} · {h.action} by {h.by.upn}
                {h.note ? ` — ${h.note}` : ''}
              </Typography>
            ))
          )}
        </Collapse>
        <ErrorAlert error={pause.error ?? trigger.error ?? del.error} />
      </CardContent>
      <CardActions sx={{ flexWrap: 'wrap' }}>
        <Button size="small" startIcon={<PlayArrowOutlined />} disabled={!mayEdit || trigger.isPending} onClick={() => trigger.mutate()}>
          Run now
        </Button>
        {!s.system && (
          <Button size="small" startIcon={<EditOutlined />} disabled={!mayEdit} onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button size="small" startIcon={<HistoryOutlined />} onClick={() => setHistory((h) => !h)}>
          History
        </Button>
        {!s.system && (
          <Button size="small" color="error" startIcon={<DeleteOutline />} disabled={!mayEdit} onClick={() => setDeleting(true)}>
            Delete
          </Button>
        )}
        {trigger.isSuccess && <Chip size="small" color="success" label="triggered" />}
      </CardActions>
      {editing && <ScheduleDialog open initial={fromSchedule(s)} scheduleId={s.scheduleId} onClose={() => setEditing(false)} />}
      <ConfirmDialog open={deleting} title="Delete schedule?" text={`"${s.title}" will no longer start tasks. Past runs remain in the audit trail.`} confirmLabel="Delete" confirmColor="error" busy={del.isPending} error={del.error} onClose={() => setDeleting(false)} onConfirm={() => del.mutate()} />
    </Card>
  );
}

export function SchedulesPage() {
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['schedules'], queryFn: api.schedules, refetchInterval: 30_000 });
  const own = q.data?.filter((s) => !s.system) ?? [];
  const system = q.data?.filter((s) => s.system) ?? [];
  return (
    <>
      <PageHeader
        title="Schedules"
        subtitle={`Recurring and future work. Times are in ${SCHEDULE_TIMEZONE}. Every run is a normal task with the schedule owner as requester.`}
        actions={
          <Button variant="contained" startIcon={<AddOutlined />} onClick={() => setCreating(true)}>
            New schedule
          </Button>
        }
      />
      <ErrorAlert error={q.error} />
      {q.isLoading && <Loading />}
      {q.data && own.length === 0 && <EmptyState title="No schedules yet" text="Create a schedule to run a task regularly, e.g. a monthly evaluation." />}
      <Grid container spacing={2}>
        {own.map((s) => (
          <Grid key={s.scheduleId} size={{ xs: 12, md: 6, xl: 4 }}>
            <ScheduleCard s={s} />
          </Grid>
        ))}
      </Grid>
      {system.length > 0 && (
        <>
          <Typography variant="h6" sx={{ mt: 4, mb: 2 }}>
            System schedules
          </Typography>
          <Grid container spacing={2}>
            {system.map((s) => (
              <Grid key={s.scheduleId} size={{ xs: 12, md: 6, xl: 4 }}>
                <ScheduleCard s={s} />
              </Grid>
            ))}
          </Grid>
        </>
      )}
      {creating && <ScheduleDialog open onClose={() => setCreating(false)} />}
    </>
  );
}
