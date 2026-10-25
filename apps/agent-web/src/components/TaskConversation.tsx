import { useEffect, useRef, useState } from 'react';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip, { type ChipProps } from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SendOutlined from '@mui/icons-material/SendOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import { Link as RouterLink } from 'react-router';
import { formatUsd, isTerminalStatus, moodForTaskStatus, type AvatarMood, type Identity, type TaskChatMessage, type TaskState } from '@cw/shared';
import { AgentPortrait, ErrorAlert, formatDateTime } from '@cw/ui';
import { api, avatarUrl } from '../api';
import { Markdown } from './Markdown';

/*
 * Chat-style history of a task: the request, what the agent reported after each step, every human decision
 * (human in the loop), comments, delegations to colleagues and the result. Derived from the workflow state, so it is
 * as complete and trustworthy as the audit trail itself. Messages are Markdown.
 */

type Entry =
  | { side: 'human'; at: string; who: Identity; text?: string; badge?: { label: string; color: ChipProps['color'] } }
  | { side: 'agent'; at: string; text: string; badge?: { label: string; color: ChipProps['color'] }; mood?: AvatarMood; files?: string[]; colleague?: string; footnote?: string; thinking?: boolean; filesLabel?: string }
  | { side: 'system'; at: string; text: string };

const STEP_LABEL: Record<string, string> = { plan: 'Plan ready', run: 'Work done', fix: 'Fixed', upload: 'Upload applied' };
const DECISION: Record<string, { label: string; color: ChipProps['color'] }> = {
  approve: { label: 'Approved', color: 'success' },
  revise: { label: 'Changes requested', color: 'warning' },
  reject: { label: 'Rejected', color: 'error' },
};

export function conversationOf(state: TaskState, agentName: string, chat: TaskChatMessage[] = []): Entry[] {
  const out: Entry[] = [];
  // questions to the agent and its answers (ADR-0030); added after the workflow events below
  const chatEntries: Entry[] = [];
  for (const m of chat) {
    if (m.role === 'user' && m.by) chatEntries.push({ side: 'human', at: m.at, who: m.by, text: m.text, badge: { label: 'Question', color: 'default' } });
    else if (m.role === 'agent')
      chatEntries.push({
        side: 'agent',
        at: m.at,
        text: m.text,
        mood: m.error ? 'fearful' : 'happy',
        badge: m.error ? { label: 'No answer', color: 'error' } : { label: 'Answer', color: 'secondary' },
        files: m.context,
        filesLabel: 'Read for this answer:',
        footnote: [m.model, m.tokens !== undefined ? `${m.tokens} tokens` : '', m.costUsd !== undefined ? formatUsd(m.costUsd) : ''].filter(Boolean).join(' · ') || undefined,
      });
  }
  const requester = state.trigger.kind === 'schedule' ? state.trigger.owner : state.requestedBy;
  out.push({
    side: 'human',
    at: state.createdAt,
    who: requester,
    text: `**${state.title}**\n\n${state.instructions}`,
    badge:
      state.trigger.kind === 'schedule'
        ? { label: `Scheduled · ${state.trigger.scheduleId}`, color: 'default' }
        : state.trigger.kind === 'agent'
          ? { label: `Delegated by agent ${state.trigger.callerAgentId}`, color: 'info' }
          : undefined,
  });
  for (const s of state.steps) {
    const isPlan = s.kind === 'plan';
    out.push({
      side: 'agent',
      at: s.endedAt,
      text: s.summary || '(no summary)',
      badge: { label: STEP_LABEL[s.kind] ?? s.kind, color: isPlan ? 'secondary' : 'primary' },
      mood: 'neutral',
      // workspace files the step changed; internal bookkeeping (.agent/) is hidden except the plan document
      files: [...new Set([...(isPlan && state.plan?.path ? [state.plan.path] : []), ...s.filesTouched.filter((f) => !f.startsWith('.agent/'))])],
    });
  }
  for (const d of state.decisions) {
    const m = DECISION[d.decision] ?? { label: d.decision, color: 'default' as const };
    out.push({ side: 'human', at: d.at, who: d.by, text: d.comment, badge: { label: `${m.label}${d.kind === 'deviation' ? ' (deviation)' : ''}`, color: m.color } });
  }
  for (const n of state.notes) out.push({ side: 'human', at: n.at, who: n.by, text: n.text });
  for (const d of state.delegations ?? []) {
    out.push({ side: 'system', at: d.at, text: `${agentName} asked colleague **${d.agentId}** for help (task \`${d.taskId}\`) — ${d.terminal ? `finished: ${d.state}` : `status: ${d.state}`}` });
    if (d.terminal && d.summary) out.push({ side: 'agent', at: d.at, text: d.summary, badge: { label: 'Answer from a colleague', color: 'info' }, colleague: d.agentId });
  }
  if (state.cancelRequested) out.push({ side: 'human', at: state.cancelRequested.at, who: state.cancelRequested.by, text: state.cancelRequested.reason, badge: { label: 'Cancelled', color: 'default' } });
  if (state.suspended) out.push({ side: 'system', at: state.suspended.at, text: `Paused by the kill switch${state.suspended.reason ? `: ${state.suspended.reason}` : ''}. Work resumes automatically.` });
  out.sort((a, b) => a.at.localeCompare(b.at));
  // the tail belongs right after the last workflow event, so later questions follow it
  const last = out.reduce((m, e) => (e.at > m ? e.at : m), state.createdAt);
  const tailAt = new Date(Date.parse(last) + 1).toISOString();

  // Tail: what happens now
  if (state.status === 'awaiting_approval') {
    out.push({
      side: 'agent',
      at: tailAt,
      mood: 'doubt',
      text:
        state.awaiting === 'deviation'
          ? 'Verification found deviations. Please decide whether to accept the result.'
          : 'My plan is ready. Please approve it, request changes or reject it. Everybody with access to me was notified by e-mail.',
      badge: { label: 'Waiting for you', color: 'warning' },
    });
  } else if (state.status === 'completed' && state.result) {
    // the last report usually is the result: show it once, as the result
    const result = state.result;
    const dup = out.findIndex((e) => e.side === 'agent' && e.text === result.summary && !e.colleague);
    if (dup >= 0) out.splice(dup, 1);
    out.push({ side: 'agent', at: tailAt, mood: 'happy', text: state.result.summary, badge: { label: 'Result', color: 'success' }, files: state.result.outputs.filter((o) => !o.startsWith('.agent/')) });
  } else if (state.error && ['failed', 'budget_exceeded', 'expired'].includes(state.status)) {
    out.push({ side: 'agent', at: tailAt, mood: 'fearful', text: state.error, badge: { label: state.status.replace(/_/g, ' '), color: 'error' } });
  }
  out.push(...chatEntries);
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

const initials = (who: Identity) =>
  (who.name || who.upn)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');

function Bubble({ entry, agentName, onOpenFile }: { entry: Entry; agentName: string; onOpenFile: (path: string) => void }) {
  if (entry.side === 'system') {
    return (
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, my: 0.5 }}>
        <Divider sx={{ flex: 1 }} />
        <Box sx={{ typography: 'caption', color: 'text.secondary', maxWidth: '75%', textAlign: 'center', '& p': { m: 0 } }}>
          <Markdown>{entry.text}</Markdown>
        </Box>
        <Divider sx={{ flex: 1 }} />
      </Stack>
    );
  }
  const human = entry.side === 'human';
  return (
    <Stack direction={human ? 'row-reverse' : 'row'} spacing={1.5} sx={{ alignItems: 'flex-start' }}>
      {human ? (
        <Avatar sx={{ width: 36, height: 36, fontSize: 14, bgcolor: 'primary.main' }}>{initials(entry.who)}</Avatar>
      ) : entry.colleague ? (
        <Avatar sx={{ width: 40, height: 40, bgcolor: 'secondary.main' }}>{entry.colleague[0]!.toUpperCase()}</Avatar>
      ) : (
        <AgentPortrait src={avatarUrl} mood={entry.mood} name={agentName} size={40} />
      )}
      <Box sx={{ maxWidth: { xs: '90%', md: human ? '78%' : '88%' }, minWidth: 0 }}>
        <Stack direction={human ? 'row-reverse' : 'row'} spacing={1} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap' }}>
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {human ? entry.who.name || entry.who.upn : entry.colleague ? `${entry.colleague[0]!.toUpperCase()}${entry.colleague.slice(1)} (colleague)` : agentName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatDateTime(entry.at)}
          </Typography>
          {entry.badge && <Chip size="small" label={entry.badge.label} color={entry.badge.color} variant={entry.badge.color === 'default' ? 'outlined' : 'filled'} />}
          {!human && entry.footnote && (
            <Typography variant="caption" color="text.secondary">
              {entry.footnote}
            </Typography>
          )}
        </Stack>
        {(entry.text || (!human && entry.files?.length)) && (
          <Box
            sx={{
              px: 1.75,
              py: 0.5,
              borderRadius: 2,
              borderTopRightRadius: human ? 4 : 16,
              borderTopLeftRadius: human ? 16 : 4,
              bgcolor: human ? 'primary.main' : 'action.hover',
              color: human ? 'primary.contrastText' : 'text.primary',
              '& a': { color: 'inherit' },
              '& code': human ? { bgcolor: 'rgba(255,255,255,0.18)' } : undefined,
              overflowWrap: 'break-word',
              '& table': { width: '100%' },
            }}
          >
            {!human && entry.thinking ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 1, fontStyle: 'italic' }}>
                {entry.text}
              </Typography>
            ) : (
              entry.text && <Markdown>{entry.text}</Markdown>
            )}
            {!human && !!entry.files?.length && (
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, my: 1, alignItems: 'center' }}>
                {entry.filesLabel && (
                  <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                    {entry.filesLabel}
                  </Typography>
                )}
                {entry.files.map((f) => (
                  <Chip key={f} size="small" variant="outlined" label={f} onClick={() => onOpenFile(f)} sx={{ fontFamily: 'monospace', bgcolor: 'background.paper' }} />
                ))}
              </Stack>
            )}
          </Box>
        )}
      </Box>
    </Stack>
  );
}

export function TaskConversation({
  state,
  agentName,
  chat,
  pendingQuestion,
  onSend,
  sending,
  error,
  onOpenFile,
}: {
  state: TaskState;
  agentName: string;
  chat: TaskChatMessage[];
  /** A question that is being answered right now. */
  pendingQuestion?: string;
  onSend: (text: string) => Promise<unknown>;
  sending: boolean;
  error: unknown;
  onOpenFile: (path: string) => void;
}) {
  const [text, setText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ state: 'running' | 'done' | 'failed'; names: string[]; taskId?: string; files?: string[]; error?: string }>();

  /** "+": upload files into the workspace (an audited upload task), then mention them in the question. */
  async function uploadFiles(list: FileList | null) {
    const files = [...(list ?? [])].slice(0, 10);
    if (!files.length) return;
    setUpload({ state: 'running', names: files.map((f) => f.name) });
    try {
      const r = await api.upload(files, 'uploads');
      // wait until the upload task has committed the files, so the agent can read them right away
      for (let i = 0; i < 60; i++) {
        const st = (await api.task(r.taskId)).state.status;
        if (st === 'completed') break;
        if (isTerminalStatus(st)) throw new Error(`upload task ended as ${st}`);
        await new Promise((res) => setTimeout(res, 1000));
      }
      setUpload({ state: 'done', names: files.map((f) => f.name), taskId: r.taskId, files: r.files });
      const mention = r.files.map((f) => `\`${f}\``).join(' ');
      setText((t) => (t.trim() ? `${t.trim()} ${mention} ` : `${mention} `));
    } catch (err) {
      setUpload({ state: 'failed', names: files.map((f) => f.name), error: err instanceof Error ? err.message : String(err) });
    }
  }
  const entries = conversationOf(state, agentName, chat);
  if (pendingQuestion) {
    const now = new Date().toISOString();
    entries.push(
      { side: 'human', at: now, who: { upn: '', name: 'You', oid: '' }, text: pendingQuestion, badge: { label: 'Question', color: 'default' } },
      { side: 'agent', at: now, text: `${agentName} is reading the task and its files…`, thinking: true, mood: 'neutral' },
    );
  }
  // keep the newest message in view — scroll the chat panel only, never the page
  const list = useRef<HTMLDivElement>(null);
  const last = entries[entries.length - 1];
  const signature = `${entries.length}:${last?.at}:${last?.side === 'system' ? '' : last?.text?.length ?? 0}`;
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [signature]);
  return (
    <Card>
      <CardHeader
        avatar={<AgentPortrait src={avatarUrl} mood={moodForTaskStatus(state.status)} name={agentName} size={40} />}
        title="Conversation"
        subheader={`Request, reports and decisions — ask ${agentName} anything about this task (Markdown supported)`}
      />
      <CardContent sx={{ pt: 0 }}>
        <Stack ref={list} spacing={2} sx={{ maxHeight: '70vh', overflowY: 'auto', pr: 1, py: 1 }}>
          {entries.map((e, i) => (
            <Bubble key={i} entry={e} agentName={agentName} onOpenFile={onOpenFile} />
          ))}
        </Stack>
        <Stack
          component="form"
          direction="row"
          spacing={1}
          sx={{ mt: 2, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void onSend(text.trim()).then(() => setText(''));
          }}
        >
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ''; }} />
          <Tooltip title="Upload files into the workspace (e.g. a picture, a spreadsheet) and ask about them">
            <span>
              <IconButton aria-label="Upload files" onClick={() => fileInput.current?.click()} disabled={upload?.state === 'running'} sx={{ mb: 0.25 }}>
                {upload?.state === 'running' ? <CircularProgress size={22} /> : <AddOutlined />}
              </IconButton>
            </span>
          </Tooltip>
          <TextField
            fullWidth
            multiline
            minRows={1}
            maxRows={8}
            size="small"
            label={`Ask ${agentName}`}
            placeholder="e.g. What is shown in the picture? Why did you choose this supplier? (Ctrl+Enter sends)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) void onSend(text.trim()).then(() => setText(''));
            }}
          />
          <Button type="submit" variant="contained" endIcon={<SendOutlined />} disabled={!text.trim() || sending}>
            Send
          </Button>
        </Stack>
        {upload && (
          <Alert
            severity={upload.state === 'failed' ? 'error' : upload.state === 'done' ? 'success' : 'info'}
            onClose={upload.state === 'running' ? undefined : () => setUpload(undefined)}
            sx={{ mt: 1 }}
          >
            {upload.state === 'running' && `Uploading ${upload.names.join(', ')} into the workspace…`}
            {upload.state === 'done' && (
              <>
                Uploaded to the workspace: {upload.files?.join(', ')}. The files are mentioned in your question, so {agentName} reads them.{' '}
                {upload.taskId && (
                  <Link component={RouterLink} to={`/tasks/${encodeURIComponent(upload.taskId)}`}>
                    Upload task
                  </Link>
                )}
              </>
            )}
            {upload.state === 'failed' && `Upload failed: ${upload.error}`}
          </Alert>
        )}
        <ErrorAlert error={error} />
      </CardContent>
    </Card>
  );
}
