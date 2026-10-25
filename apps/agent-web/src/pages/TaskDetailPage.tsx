import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import EditNoteOutlined from '@mui/icons-material/EditNoteOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import { ACTIVE_STATUSES, isTerminalStatus, moodForTaskStatus, type TaskState } from '@cw/shared';
import { AgentPortrait, ConfirmDialog, ErrorAlert, KeyValueList, Loading, PageHeader, RelativeTime, StatusChip, TimelineChart, formatDateTime, formatNumber } from '@cw/ui';
import { api, avatarUrl, hasRole, useMe } from '../api';
import { CommitList, DiffDialog } from '../components/CommitList';
import { LivePanel } from '../components/LivePanel';
import { FilePreviewDialog } from '../components/FilePreview';
import { TaskConversation } from '../components/TaskConversation';
import { Markdown } from '../components/Markdown';

type Pending = { kind: 'approve' | 'revise' | 'reject' | 'cancel' } | undefined;

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const me = useMe();
  const [pending, setPending] = useState<Pending>();
  const [diff, setDiff] = useState<string>();
  const [previewPath, setPreviewPath] = useState<string>();
  const [params, setParams] = useSearchParams();
  const deepLinkHandled = useRef(false);

  const detail = useQuery({
    queryKey: ['task', id],
    queryFn: () => api.task(id),
    refetchInterval: (q) => (q.state.data && isTerminalStatus(q.state.data.state.status) ? false : 5_000),
  });
  const state = detail.data?.state;
  const active = !!state && (ACTIVE_STATUSES as readonly string[]).includes(state.status);
  const timeline = useQuery({ queryKey: ['task-timeline', id], queryFn: () => api.taskTimeline(id), refetchInterval: active ? 5_000 : false, enabled: !!state });
  const plan = useQuery({
    queryKey: ['plan', state?.plan?.path, state?.plan?.commit],
    queryFn: () => api.fileText(state!.plan!.path),
    enabled: !!state?.plan?.path,
  });
  const commits = useQuery({ queryKey: ['task-commits', id, state?.steps.length, state?.status], queryFn: () => api.commits({ taskId: id, limit: 100 }), enabled: !!state });

  const refresh = (s?: TaskState) => {
    if (s && detail.data) qc.setQueryData(['task', id], { ...detail.data, state: s });
    void qc.invalidateQueries({ queryKey: ['task', id] });
    void qc.invalidateQueries({ queryKey: ['task-timeline', id] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
  const act = useMutation({
    mutationFn: async ({ kind, text }: { kind: NonNullable<Pending>['kind']; text: string }) =>
      kind === 'cancel' ? api.cancel(id, text) : api.decide(id, kind, text),
    onSuccess: (s) => {
      setPending(undefined);
      refresh(s);
    },
  });
  const addComment = useMutation({
    mutationFn: (text: string) => api.comment(id, text),
    onSuccess: (st) => refresh(st),
  });

  const decideParam = params.get('decide');
  useEffect(() => {
    if (deepLinkHandled.current || !decideParam || !state || !me.data) return;
    deepLinkHandled.current = true;
    const next = new URLSearchParams(params);
    next.delete('decide');
    setParams(next, { replace: true });
    if (state.status !== 'awaiting_approval') return;
    const owner = state.trigger.kind === 'schedule' ? state.trigger.owner : state.requestedBy;
    const allowed = hasRole(me.data, 'approver') || me.data.user.upn === owner.upn;
    if (allowed && (decideParam === 'approve' || decideParam === 'revise' || decideParam === 'reject')) setPending({ kind: decideParam });
    else setTimeout(() => document.getElementById('decision')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
  }, [decideParam, state, me.data, params, setParams]);

  if (detail.isLoading) return <Loading />;
  if (detail.error || !state) return <ErrorAlert error={detail.error ?? new Error('Task not found')} />;

  const user = me.data?.user;
  const owner = state.trigger.kind === 'schedule' ? state.trigger.owner : state.requestedBy;
  const mayDecide = !!user && (hasRole(me.data, 'approver') || user.upn === owner.upn);
  const mayCancel = !!user && !isTerminalStatus(state.status) && !state.cancelRequested && (user.upn === state.requestedBy.upn || hasRole(me.data, 'admin'));
  const usagePct = Math.min(100, (state.usage.tokens / Math.max(1, state.usage.maxTokens)) * 100);

  return (
    <>
      <PageHeader
        overline={<Link component={RouterLink} to="/tasks">Tasks</Link>}
        title={state.title}
        subtitle={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mt: 1 }}>
            <AgentPortrait src={avatarUrl} mood={moodForTaskStatus(state.status)} name={me.data?.agent.displayName ?? 'Agent'} size={48} />
            <StatusChip status={state.status} size="medium" />
            <Chip variant="outlined" label={state.type} />
            <Chip variant="outlined" label={triggerLabel(state)} />
            {detail.data?.source === 'audit-export' && <Chip color="warning" label="from audit export (beyond retention)" />}
            {state.lock !== 'none' && <Chip color="info" variant="outlined" label={state.lock === 'held' ? 'holds the workspace' : 'waiting for the workspace'} />}
          </Stack>
        }
        actions={
          mayCancel ? (
            <Button color="error" variant="outlined" startIcon={<StopCircleOutlined />} onClick={() => setPending({ kind: 'cancel' })}>
              Cancel task
            </Button>
          ) : undefined
        }
      />

      {state.suspended && state.status === 'suspended' && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <AlertTitle>Suspended by the kill switch</AlertTitle>
          The running step was aborted {formatDateTime(state.suspended.at)}{state.suspended.reason ? ` (${state.suspended.reason})` : ''}. It resumes automatically when an
          administrator lifts the pause.
        </Alert>
      )}

      {state.status === 'awaiting_approval' && (
        <Card id="decision" sx={{ mb: 3, borderColor: 'warning.main', borderWidth: 2, scrollMarginTop: 80 }}>
          <CardHeader
            title={state.awaiting === 'deviation' ? 'Verification found deviations — approve the result?' : 'The plan is waiting for approval'}
            subheader={`Requested by ${owner.name || owner.upn}${state.revisions ? ` · revision ${state.revisions}` : ''}. ${mayDecide ? '' : 'Only approvers or the requester can decide.'}`}
          />
          <CardContent sx={{ pt: 0 }}>
            {state.awaiting === 'deviation' && state.verify?.anomalies?.length ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                <AlertTitle>Anomalies</AlertTitle>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {state.verify.anomalies.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {state.awaiting !== 'deviation' && (
              <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, maxHeight: 520, overflow: 'auto', mb: 2 }}>
                {plan.isLoading ? <Loading label="Loading plan…" /> : plan.data ? <Markdown>{plan.data}</Markdown> : <ErrorAlert error={plan.error} />}
              </Box>
            )}
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <Button variant="contained" color="success" startIcon={<CheckOutlined />} disabled={!mayDecide} onClick={() => setPending({ kind: 'approve' })}>
                Approve
              </Button>
              <Button variant="outlined" startIcon={<EditNoteOutlined />} disabled={!mayDecide} onClick={() => setPending({ kind: 'revise' })}>
                Request changes
              </Button>
              <Button variant="outlined" color="error" startIcon={<CloseOutlined />} disabled={!mayDecide} onClick={() => setPending({ kind: 'reject' })}>
                Reject
              </Button>
            </Stack>
          </CardContent>
        </Card>
      )}

      {state.error && isTerminalStatus(state.status) && state.status !== 'completed' && (
        <Alert severity={state.status === 'failed' || state.status === 'budget_exceeded' ? 'error' : 'info'} sx={{ mb: 3 }}>
          {state.error}
        </Alert>
      )}
      {state.result && state.status === 'completed' && (
        <Alert severity="success" sx={{ mb: 3 }}>
          <AlertTitle>Result</AlertTitle>
          {state.result.summary}
          {state.result.outputs.length > 0 && (
            <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
              {state.result.outputs
                .filter((o) => !o.startsWith('.agent/'))
                .map((o) => (
                  <Chip key={o} size="small" onClick={() => setPreviewPath(o)} clickable label={o} sx={{ fontFamily: 'monospace' }} />
                ))}
            </Stack>
          )}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Stack spacing={3}>
            {active && <LivePanel taskId={id} />}
            <TaskConversation
              state={state}
              agentName={me.data?.agent.displayName ?? 'Agent'}
              onSend={(text) => addComment.mutateAsync(text)}
              sending={addComment.isPending}
              error={addComment.error}
              onOpenFile={setPreviewPath}
            />
            <Card>
              <CardHeader title="Activity timeline" subheader="From the Temporal event history" />
              <CardContent>{timeline.data ? <TimelineChart timeline={timeline.data} showLegend /> : timeline.isLoading ? <Loading /> : <ErrorAlert error={timeline.error} />}</CardContent>
            </Card>
            <Card>
              <CardHeader title="Steps" subheader={`${state.steps.length} step(s)`} />
              <CardContent sx={{ pt: 0 }}>
                {state.steps.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    No steps yet.
                  </Typography>
                )}
                {state.steps.map((s) => (
                  <Accordion key={s.stepId} disableGutters variant="outlined" sx={{ mb: 1, '&:before': { display: 'none' } }}>
                    <AccordionSummary expandIcon={<ExpandMoreOutlined />} sx={{ '& .MuiAccordionSummary-content': { minWidth: 0, overflow: 'hidden' } }}>
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
                        <Chip size="small" label={s.kind} color={s.kind === 'plan' ? 'secondary' : s.kind === 'fix' ? 'warning' : 'primary'} />
                        <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: 1 }}>
                          {s.summary}
                        </Typography>
                      </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Typography variant="body2" sx={{ mb: 2, whiteSpace: 'pre-wrap' }}>
                        {s.summary}
                      </Typography>
                      <KeyValueList
                        dense
                        items={[
                          ['Step', s.stepId],
                          ['Time', `${formatDateTime(s.startedAt)} → ${formatDateTime(s.endedAt)}`],
                          ['Tokens', formatNumber(s.tokens)],
                          [
                            'Commit',
                            s.commit ? (
                              <Link component="button" onClick={() => setDiff(s.commit)} sx={{ fontFamily: 'monospace' }}>
                                {s.commit.slice(0, 10)}
                              </Link>
                            ) : (
                              '–'
                            ),
                          ],
                          ['Files', s.filesTouched.length ? s.filesTouched.join(', ') : '–'],
                          ['Transcript', s.artifacts.join(', ') || '–'],
                        ]}
                      />
                    </AccordionDetails>
                  </Accordion>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader title="Commits" subheader="Git history of this task (with trailers)" />
              <CardContent sx={{ pt: 0 }}>{commits.data ? <CommitList commits={commits.data} dense /> : <Loading />}</CardContent>
            </Card>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, lg: 4 }}>
          <Stack spacing={3}>
            {!!state.delegations?.length && <DelegationsCard state={state} />}
            <Card>
              <CardHeader title="Details" />
              <CardContent sx={{ pt: 0 }}>
                <KeyValueList
                  items={[
                    ['Task id', <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{state.taskId}</Typography>],
                    ['Requested by', `${state.requestedBy.name} (${state.requestedBy.upn})`],
                    ['Created', <RelativeTime iso={state.createdAt} />],
                    ['Approval', state.approval],
                    ['Approved by', state.approvedBy.join(', ') || '–'],
                    ['Verification', state.verify ? `${state.verify.ok ? 'passed' : 'failed'} (round ${state.verify.round})` : '–'],
                    ['Audit export', state.result?.auditPath ?? '–'],
                  ]}
                />
                <Box sx={{ mt: 2 }}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary">
                      Token budget
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatNumber(state.usage.tokens)} / {formatNumber(state.usage.maxTokens)}
                    </Typography>
                  </Stack>
                  <LinearProgress variant="determinate" value={usagePct} color={usagePct > 90 ? 'error' : usagePct > 70 ? 'warning' : 'primary'} sx={{ height: 8, borderRadius: 4 }} />
                </Box>
                {me.data?.temporalUiUrl && hasRole(me.data, 'admin') && (
                  <Button size="small" sx={{ mt: 2 }} endIcon={<OpenInNewOutlined />} href={`${me.data.temporalUiUrl}/namespaces/${me.data.temporalNamespace}/workflows/${encodeURIComponent(state.taskId)}`} target="_blank" rel="noreferrer">
                    Open in Temporal UI
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader title="Instructions" />
              <CardContent sx={{ pt: 0 }}>
                <Markdown>{state.instructions}</Markdown>
              </CardContent>
            </Card>
          </Stack>
        </Grid>
      </Grid>

      <FilePreviewDialog path={previewPath} onClose={() => setPreviewPath(undefined)} />
      <ConfirmDialog
        open={!!pending}
        title={
          pending?.kind === 'approve' ? 'Approve' : pending?.kind === 'revise' ? 'Request changes' : pending?.kind === 'reject' ? 'Reject task' : 'Cancel task'
        }
        text={
          pending?.kind === 'approve'
            ? 'The agent will continue with the approved plan. Your decision is recorded with your identity.'
            : pending?.kind === 'revise'
              ? 'Describe what should change. The agent will revise the plan.'
              : pending?.kind === 'reject'
                ? 'The task ends without further changes. A reason is required.'
                : 'The running step is aborted and the task ends.'
        }
        confirmLabel={pending?.kind === 'approve' ? 'Approve' : pending?.kind === 'revise' ? 'Request changes' : pending?.kind === 'reject' ? 'Reject' : 'Cancel task'}
        confirmColor={pending?.kind === 'approve' ? 'success' : pending?.kind === 'revise' ? 'primary' : 'error'}
        comment={{ label: pending?.kind === 'approve' ? 'Comment (optional)' : pending?.kind === 'cancel' ? 'Reason (optional)' : 'Comment', required: pending?.kind === 'reject' || pending?.kind === 'revise' }}
        busy={act.isPending}
        error={act.error}
        onClose={() => {
          act.reset();
          setPending(undefined);
        }}
        onConfirm={(text) => pending && act.mutate({ kind: pending.kind, text })}
      />
      <DiffDialog hash={diff} onClose={() => setDiff(undefined)} />
    </>
  );
}

function triggerLabel(state: TaskState): string {
  switch (state.trigger.kind) {
    case 'schedule':
      return `scheduled · ${state.trigger.scheduleId}`;
    case 'agent':
      return `delegated by agent ${state.trigger.callerAgentId} for ${state.requestedBy.name || state.requestedBy.upn}`;
    default:
      return 'requested by a person';
  }
}

/** Tasks this task delegated to colleagues via A2A (ADR-0023). */
function DelegationsCard({ state }: { state: TaskState }) {
  return (
    <Card>
      <CardHeader title="Delegated to colleagues" subheader="A2A tasks on other agents; results flow back into this task" />
      <CardContent sx={{ pt: 0 }}>
        <List dense disablePadding>
          {state.delegations!.map((d) => (
            <ListItem key={`${d.agentId}/${d.taskId}`} disableGutters sx={{ alignItems: 'flex-start' }}>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography variant="subtitle2">{d.agentId}</Typography>
                    <StatusChip status={a2aStatus(d.state)} />
                  </Stack>
                }
                secondary={
                  <>
                    <Typography component="span" variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
                      {d.taskId}
                    </Typography>
                    {d.summary && (
                      <Typography component="span" variant="body2" sx={{ display: 'block', mt: 0.5 }}>
                        {d.summary.length > 280 ? `${d.summary.slice(0, 280)}…` : d.summary}
                      </Typography>
                    )}
                  </>
                }
              />
            </ListItem>
          ))}
        </List>
      </CardContent>
    </Card>
  );
}

const a2aStatus = (s: string) =>
  ({ completed: 'completed', failed: 'failed', canceled: 'cancelled', cancelled: 'cancelled', rejected: 'rejected', submitted: 'queued', working: 'running' })[
    s.replace(/^TASK_STATE_/, '').toLowerCase()
  ] ?? s.toLowerCase();
