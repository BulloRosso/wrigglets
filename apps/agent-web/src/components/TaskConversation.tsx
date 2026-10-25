import { useEffect, useRef, useState } from 'react';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip, { type ChipProps } from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SendOutlined from '@mui/icons-material/SendOutlined';
import { moodForTaskStatus, type AvatarMood, type Identity, type TaskState } from '@cw/shared';
import { AgentPortrait, ErrorAlert, formatDateTime } from '@cw/ui';
import { avatarUrl } from '../api';
import { Markdown } from './Markdown';

/*
 * Chat-style history of a task: the request, what the agent reported after each step, every human decision
 * (human in the loop), comments, delegations to colleagues and the result. Derived from the workflow state, so it is
 * as complete and trustworthy as the audit trail itself. Messages are Markdown.
 */

type Entry =
  | { side: 'human'; at: string; who: Identity; text?: string; badge?: { label: string; color: ChipProps['color'] } }
  | { side: 'agent'; at: string; text: string; badge?: { label: string; color: ChipProps['color'] }; mood?: AvatarMood; files?: string[]; colleague?: string }
  | { side: 'system'; at: string; text: string };

const STEP_LABEL: Record<string, string> = { plan: 'Plan ready', run: 'Work done', fix: 'Fixed', upload: 'Upload applied' };
const DECISION: Record<string, { label: string; color: ChipProps['color'] }> = {
  approve: { label: 'Approved', color: 'success' },
  revise: { label: 'Changes requested', color: 'warning' },
  reject: { label: 'Rejected', color: 'error' },
};

export function conversationOf(state: TaskState, agentName: string): Entry[] {
  const out: Entry[] = [];
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

  // Tail: what happens now
  if (state.status === 'awaiting_approval') {
    out.push({
      side: 'agent',
      at: new Date().toISOString(),
      mood: 'doubt',
      text:
        state.awaiting === 'deviation'
          ? 'Verification found deviations. Please decide whether to accept the result.'
          : 'My plan is ready. Please approve it, request changes or reject it. Everybody with access to me was notified by e-mail.',
      badge: { label: 'Waiting for you', color: 'warning' },
    });
  } else if (state.status === 'completed' && state.result) {
    out.push({ side: 'agent', at: new Date().toISOString(), mood: 'happy', text: state.result.summary, badge: { label: 'Result', color: 'success' }, files: state.result.outputs.filter((o) => !o.startsWith('.agent/')) });
  } else if (state.error && ['failed', 'budget_exceeded', 'expired'].includes(state.status)) {
    out.push({ side: 'agent', at: new Date().toISOString(), mood: 'fearful', text: state.error, badge: { label: state.status.replace(/_/g, ' '), color: 'error' } });
  }
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
      <Box sx={{ maxWidth: { xs: '85%', md: '78%' }, minWidth: 0 }}>
        <Stack direction={human ? 'row-reverse' : 'row'} spacing={1} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap' }}>
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {human ? entry.who.name || entry.who.upn : entry.colleague ? `${entry.colleague[0]!.toUpperCase()}${entry.colleague.slice(1)} (colleague)` : agentName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatDateTime(entry.at)}
          </Typography>
          {entry.badge && <Chip size="small" label={entry.badge.label} color={entry.badge.color} variant={entry.badge.color === 'default' ? 'outlined' : 'filled'} />}
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
              overflowWrap: 'anywhere',
            }}
          >
            {entry.text && <Markdown>{entry.text}</Markdown>}
            {!human && !!entry.files?.length && (
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, my: 1 }}>
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
  onSend,
  sending,
  error,
  onOpenFile,
}: {
  state: TaskState;
  agentName: string;
  onSend: (text: string) => Promise<unknown>;
  sending: boolean;
  error: unknown;
  onOpenFile: (path: string) => void;
}) {
  const [text, setText] = useState('');
  const entries = conversationOf(state, agentName);
  // keep the newest message in view — scroll the chat panel only, never the page
  const list = useRef<HTMLDivElement>(null);
  const count = entries.length;
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [count]);
  return (
    <Card>
      <CardHeader
        avatar={<AgentPortrait src={avatarUrl} mood={moodForTaskStatus(state.status)} name={agentName} size={40} />}
        title="Conversation"
        subheader="Request, agent reports, decisions and comments — Markdown supported"
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
          <TextField
            fullWidth
            multiline
            minRows={1}
            maxRows={8}
            size="small"
            label="Write a comment"
            placeholder="Markdown supported. Decisions are made with the buttons above."
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
        <ErrorAlert error={error} />
      </CardContent>
    </Card>
  );
}
