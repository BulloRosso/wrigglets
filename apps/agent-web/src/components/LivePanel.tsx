import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TerminalOutlined from '@mui/icons-material/TerminalOutlined';
import type { LiveEvent } from '@cw/shared';
import { formatNumber } from '@cw/ui';

type ToolEv = Extract<LiveEvent, { type: 'tool' }>;
type TextEv = Extract<LiveEvent, { type: 'text' }>;

/** Live view of the running harness step (SSE, spec §9.3): streaming text and compact tool rows. */
export function LivePanel({ taskId }: { taskId: string }) {
  const [entries, setEntries] = useState<Array<TextEv | ToolEv | Extract<LiveEvent, { type: 'step' | 'error' }>>>([]);
  const [active, setActive] = useState(false);
  const [tokens, setTokens] = useState({ input: 0, output: 0 });
  const [connected, setConnected] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/live`);
    const upsert = (ev: TextEv | ToolEv) =>
      setEntries((prev) => {
        const i = prev.findIndex((p) => (p.type === 'text' || p.type === 'tool') && p.partId === ev.partId);
        if (i === -1) return [...prev, ev].slice(-200);
        const next = prev.slice();
        next[i] = ev;
        return next;
      });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('text', (m) => upsert(JSON.parse((m as MessageEvent).data) as TextEv));
    es.addEventListener('tool', (m) => upsert(JSON.parse((m as MessageEvent).data) as ToolEv));
    es.addEventListener('step', (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as Extract<LiveEvent, { type: 'step' }>;
      setActive(ev.phase === 'started');
      setEntries((prev) => [...prev, ev].slice(-200));
    });
    es.addEventListener('error', (m) => {
      const data = (m as MessageEvent).data;
      if (data) setEntries((prev) => [...prev, JSON.parse(data) as Extract<LiveEvent, { type: 'error' }>]);
    });
    es.addEventListener('idle', () => setActive(false));
    es.addEventListener('tokens', (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as Extract<LiveEvent, { type: 'tokens' }>;
      setTokens((t) => ({ input: t.input + ev.input, output: t.output + ev.output }));
    });
    return () => es.close();
  }, [taskId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [entries]);

  return (
    <Card>
      <CardHeader
        avatar={<TerminalOutlined color={active ? 'primary' : 'disabled'} />}
        title="Live activity"
        subheader={active ? 'The Agent Harness is working on a step…' : connected ? 'Idle — waiting for the next step' : 'Connecting…'}
        action={tokens.input + tokens.output > 0 ? <Chip size="small" variant="outlined" label={`${formatNumber(tokens.input + tokens.output)} tokens (this session)`} /> : undefined}
      />
      {active && <LinearProgress />}
      <CardContent sx={{ maxHeight: 420, overflow: 'auto', pt: 1 }}>
        {entries.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No live events yet.
          </Typography>
        )}
        <Stack spacing={1}>
          {entries.map((e, i) => {
            if (e.type === 'step') {
              return (
                <Typography key={i} variant="overline" color="text.secondary">
                  {e.phase === 'started' ? '▶' : '■'} step {e.kind} {e.phase}
                </Typography>
              );
            }
            if (e.type === 'error') {
              return (
                <Typography key={i} variant="body2" color="error">
                  {e.message}
                </Typography>
              );
            }
            if (e.type === 'tool') {
              return (
                <Stack key={e.partId} direction="row" spacing={1} sx={{ alignItems: 'center', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 }}>
                  <Chip size="small" label={e.tool} color={e.status === 'error' ? 'error' : e.status === 'completed' ? 'success' : 'default'} variant="outlined" />
                  <Box component="span" sx={{ color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.title ?? e.files?.join(', ') ?? e.status}
                  </Box>
                </Stack>
              );
            }
            return (
              <Typography key={e.partId} variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {e.truncated ? '… ' : ''}
                {e.text}
              </Typography>
            );
          })}
        </Stack>
        <div ref={bottom} />
      </CardContent>
    </Card>
  );
}
