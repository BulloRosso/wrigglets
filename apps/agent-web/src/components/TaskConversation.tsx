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
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import EventRepeatOutlined from '@mui/icons-material/EventRepeatOutlined';
import { Link as RouterLink } from 'react-router';
import { describeCalendar, formatUsd, isTerminalStatus, moodForTaskStatus, type AvatarMood, type Identity, type ScheduleProposal, type TaskChatMessage, type TaskState } from '@cw/shared';
import { AgentPortrait, ErrorAlert, formatBytes, formatDateTime } from '@cw/ui';
import { api, avatarUrl } from '../api';
import { Markdown } from './Markdown';

/*
 * Chat-style history of a task: the request, what the agent reported after each step, every human decision
 * (human in the loop), comments, delegations to colleagues and the result. Derived from the workflow state, so it is
 * as complete and trustworthy as the audit trail itself. Messages are Markdown.
 */

type Entry =
  | { side: 'human'; at: string; who: Identity; text?: string; badge?: { label: string; color: ChipProps['color'] } }
  | { side: 'agent'; at: string; text: string; badge?: { label: string; color: ChipProps['color'] }; mood?: AvatarMood; files?: string[]; colleague?: string; footnote?: string; thinking?: boolean; filesLabel?: string; proposal?: { id: string; p: ScheduleProposal } }
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
        badge: m.error ? { label: 'No answer', color: 'error' } : m.proposal ? { label: 'Schedule proposal', color: 'info' } : { label: 'Answer', color: 'secondary' },
        files: m.context,
        filesLabel: 'Read for this answer:',
        proposal: m.proposal ? { id: m.id, p: m.proposal } : undefined,
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

const PROPOSAL_STATUS: Record<ScheduleProposal['status'], { label: string; color: ChipProps['color'] }> = {
  pending: { label: 'Waiting for your approval', color: 'warning' },
  approved: { label: 'Approved', color: 'success' },
  rejected: { label: 'Rejected', color: 'default' },
};

/** The agent's proposal for a recurring task: shows exactly what would run and when; only the buttons create it. */
function ProposalCard({ p, mayDecide, deciding, onDecide }: { p: ScheduleProposal; mayDecide: boolean; deciding: boolean; onDecide: (decision: 'approve' | 'reject') => void }) {
  const status = PROPOSAL_STATUS[p.status];
  return (
    <Box sx={{ my: 1, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
        <EventRepeatOutlined fontSize="small" color="action" />
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }}>
          {p.schedule.title}
        </Typography>
        <Chip size="small" label={status.label} color={status.color} variant={p.status === 'rejected' ? 'outlined' : 'filled'} />
      </Stack>
      <Typography variant="body2">
        <strong>When:</strong> {describeCalendar(p.schedule.calendar)} (Europe/Berlin)
      </Typography>
      <Typography variant="body2">
        <strong>Type:</strong> {p.schedule.type} · <strong>approval:</strong> {p.schedule.approval}
      </Typography>
      <Typography variant="body2" component="div" sx={{ mt: 1 }}>
        <strong>Instructions for every run:</strong>
        <Box sx={{ mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'action.hover', whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>{p.schedule.instructions}</Box>
      </Typography>
      {p.status === 'pending' && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: 'center' }}>
          <Button size="small" variant="contained" disabled={!mayDecide || deciding} onClick={() => onDecide('approve')}>
            Approve &amp; schedule
          </Button>
          <Button size="small" disabled={!mayDecide || deciding} onClick={() => onDecide('reject')}>
            Reject
          </Button>
          {deciding && <CircularProgress size={18} />}
          {!mayDecide && (
            <Typography variant="caption" color="text.secondary">
              Only {p.requestedBy.name || p.requestedBy.upn} can decide.
            </Typography>
          )}
        </Stack>
      )}
      {p.status === 'approved' && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
          Approved by {p.decidedBy?.name || p.decidedBy?.upn} — scheduled as{' '}
          <Link component={RouterLink} to="/schedules">
            {p.scheduleId}
          </Link>
          . It runs under their name.
        </Typography>
      )}
      {p.status === 'rejected' && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
          Rejected by {p.decidedBy?.name || p.decidedBy?.upn}. Nothing was scheduled.
        </Typography>
      )}
    </Box>
  );
}

interface ProposalActions {
  canDecide: (p: ScheduleProposal) => boolean;
  deciding?: string;
  onDecide: (messageId: string, decision: 'approve' | 'reject') => void;
}

function Bubble({ entry, agentName, onOpenFile, proposals }: { entry: Entry; agentName: string; onOpenFile: (path: string) => void; proposals: ProposalActions }) {
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
        {(entry.text || (!human && (entry.files?.length || entry.proposal))) && (
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
            {!human && entry.proposal && (
              <ProposalCard
                p={entry.proposal.p}
                mayDecide={proposals.canDecide(entry.proposal.p)}
                deciding={proposals.deciding === entry.proposal.id}
                onDecide={(d) => proposals.onDecide(entry.proposal!.id, d)}
              />
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

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // same limit as the upload API

/** One attached file before upload: thumbnail for images, name, size and a remove button. */
function AttachmentPreview({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled: boolean }) {
  const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(file.type);
  const [thumb, setThumb] = useState<string>();
  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pl: 0.75, pr: 0.25, py: 0.5, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1.5, maxWidth: 280 }}>
      {thumb ? (
        <Box component="img" src={thumb} alt="" sx={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 1, flexShrink: 0 }} />
      ) : (
        <InsertDriveFileOutlined color="action" sx={{ fontSize: 32, flexShrink: 0 }} />
      )}
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" noWrap title={file.name}>
          {file.name}
        </Typography>
        <Typography variant="caption" color={file.size > MAX_ATTACHMENT_BYTES ? 'error' : 'text.secondary'}>
          {formatBytes(file.size)}
        </Typography>
      </Box>
      <Tooltip title="Remove">
        <span>
          <IconButton size="small" aria-label={`Remove ${file.name}`} onClick={onRemove} disabled={disabled}>
            <CloseOutlined fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
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
  canDecideProposal,
  onDecideProposal,
  decidingProposal,
  proposalError,
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
  /** The agent may propose a recurring task; it is only created when the right person approves it here. */
  canDecideProposal: (p: ScheduleProposal) => boolean;
  onDecideProposal: (messageId: string, decision: 'approve' | 'reject') => Promise<unknown>;
  decidingProposal?: string;
  proposalError: unknown;
  onOpenFile: (path: string) => void;
}) {
  const [text, setText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  /** Files chosen with "+" — uploaded only when the message is submitted, removable until then. */
  const [attached, setAttached] = useState<File[]>([]);
  const [upload, setUpload] = useState<{ state: 'running' | 'done' | 'failed'; names: string[]; taskId?: string; files?: string[]; error?: string }>();
  const busy = sending || upload?.state === 'running';

  function attach(list: FileList | null) {
    const picked = [...(list ?? [])];
    setAttached((cur) => {
      const key = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;
      const seen = new Set(cur.map(key));
      return [...cur, ...picked.filter((f) => !seen.has(key(f)))].slice(0, MAX_ATTACHMENTS);
    });
  }
  const tooLarge = attached.filter((f) => f.size > MAX_ATTACHMENT_BYTES);

  /** Upload the attached files as one upload task and wait until they are committed, so the agent can read them. */
  async function uploadAttached(): Promise<string[]> {
    const files = attached;
    setUpload({ state: 'running', names: files.map((f) => f.name) });
    try {
      const r = await api.upload(files, 'uploads');
      for (let i = 0; i < 60; i++) {
        const st = (await api.task(r.taskId)).state.status;
        if (st === 'completed') break;
        if (isTerminalStatus(st)) throw new Error(`upload task ended as ${st}`);
        await new Promise((res) => setTimeout(res, 1000));
      }
      setUpload({ state: 'done', names: files.map((f) => f.name), taskId: r.taskId, files: r.files });
      setAttached([]);
      return r.files;
    } catch (err) {
      setUpload({ state: 'failed', names: files.map((f) => f.name), error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async function submit() {
    if (busy || (!text.trim() && !attached.length) || tooLarge.length) return;
    let question = text.trim();
    if (attached.length) {
      let paths: string[];
      try {
        paths = await uploadAttached();
      } catch {
        return; // the alert explains; files stay attached for another try
      }
      const mention = paths.map((f) => `\`${f}\``).join(' ');
      if (!question) {
        // upload only: keep the paths in the box so the next question refers to the files
        setText(`${mention} `);
        return;
      }
      question = `${mention} ${question}`;
    }
    await onSend(question);
    setText('');
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
            <Bubble key={i} entry={e} agentName={agentName} onOpenFile={onOpenFile} proposals={{ canDecide: canDecideProposal, deciding: decidingProposal, onDecide: (id, d) => void onDecideProposal(id, d).catch(() => undefined) }} />
          ))}
        </Stack>
        {attached.length > 0 && (
          <Box sx={{ mt: 2, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'action.hover' }}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {attached.length} file(s) will be uploaded to <code>uploads/</code> when you send — remove any you do not want
              </Typography>
              <Button size="small" onClick={() => setAttached([])} disabled={busy}>
                Remove all
              </Button>
            </Stack>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
              {attached.map((f, i) => (
                <AttachmentPreview key={`${f.name}:${f.size}:${f.lastModified}`} file={f} disabled={busy} onRemove={() => setAttached((cur) => cur.filter((_, j) => j !== i))} />
              ))}
            </Stack>
            {tooLarge.length > 0 && (
              <Typography variant="caption" color="error" component="div" sx={{ mt: 1 }}>
                {tooLarge.map((f) => f.name).join(', ')}: larger than {formatBytes(MAX_ATTACHMENT_BYTES)} — please remove.
              </Typography>
            )}
          </Box>
        )}
        <Stack
          component="form"
          direction="row"
          spacing={1}
          sx={{ mt: 2, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attach(e.target.files);
              e.target.value = '';
            }}
          />
          <Tooltip title={`Attach files (up to ${MAX_ATTACHMENTS}) — they are uploaded into the workspace when you send, and ${agentName} reads them`}>
            <span>
              <IconButton aria-label="Attach files" onClick={() => fileInput.current?.click()} disabled={busy || attached.length >= MAX_ATTACHMENTS} sx={{ mb: 0.25 }}>
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
            placeholder={attached.length ? 'Ask about the attached files, or send to upload them only' : 'e.g. What is shown in the picture? Why did you choose this supplier? (Ctrl+Enter sends)'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
            }}
          />
          <Button
            type="submit"
            variant="contained"
            endIcon={<SendOutlined />}
            disabled={busy || (!text.trim() && !attached.length) || tooLarge.length > 0}
            sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {attached.length ? (text.trim() ? 'Upload & send' : 'Upload') : 'Send'}
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
                Uploaded to the workspace: {upload.files?.join(', ')}.{' '}
                {upload.taskId && (
                  <Link component={RouterLink} to={`/tasks/${encodeURIComponent(upload.taskId)}`}>
                    Upload task
                  </Link>
                )}
              </>
            )}
            {upload.state === 'failed' && `Upload failed: ${upload.error}. The files are still attached — try again or remove them.`}
          </Alert>
        )}
        <ErrorAlert error={error} />
        <ErrorAlert error={proposalError} />
      </CardContent>
    </Card>
  );
}
