import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { EmptyState, ErrorAlert, Loading, PageHeader, TimelineChart } from '@cw/ui';
import { api } from '../api';

type Range = 'fit' | 'today' | '24h' | '7d' | 'custom';

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Global activity timeline: swimlanes per task, agent (workspace lock) lane on top (spec §11.1 #3). */
export function TimelinePage() {
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>('fit');
  const [custom, setCustom] = useState(() => ({ from: toLocalInput(new Date(Date.now() - 3 * 86_400_000)), to: toLocalInput(new Date()) }));

  const { from, to } = useMemo(() => {
    const now = new Date();
    if (range === 'today') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    if (range === '24h') return { from: new Date(now.getTime() - 86_400_000).toISOString(), to: now.toISOString() };
    // "fit" loads the last 7 days and lets the chart zoom to the actual activity
    if (range === '7d' || range === 'fit') return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to: now.toISOString() };
    return { from: new Date(custom.from).toISOString(), to: new Date(custom.to).toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, custom, range === 'custom' ? 0 : Math.floor(Date.now() / 60_000)]);

  const q = useQuery({ queryKey: ['timeline', range, range === 'custom' ? custom : null], queryFn: () => api.timeline(from, to), refetchInterval: range === 'custom' ? false : 10_000 });

  return (
    <>
      <PageHeader
        title="Activity timeline"
        subtitle="What the agent did, for whom, and when — reconstructed from the Temporal event history. Click a lane to open the task."
        actions={
          <ToggleButtonGroup size="small" exclusive value={range} onChange={(_, v: Range | null) => v && setRange(v)}>
            <ToggleButton value="fit">Fit</ToggleButton>
            <ToggleButton value="today">Today</ToggleButton>
            <ToggleButton value="24h">24 h</ToggleButton>
            <ToggleButton value="7d">7 days</ToggleButton>
            <ToggleButton value="custom">Custom</ToggleButton>
          </ToggleButtonGroup>
        }
      />
      {range === 'custom' && (
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <TextField type="datetime-local" label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField type="datetime-local" label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} slotProps={{ inputLabel: { shrink: true } }} />
        </Stack>
      )}
      <Card>
        <CardContent>
          <ErrorAlert error={q.error} />
          {q.isLoading ? (
            <Loading />
          ) : q.data && q.data.lanes.length > 1 ? (
            <TimelineChart timeline={q.data} from={range === 'fit' ? undefined : from} to={range === 'fit' ? undefined : to} onLaneClick={(taskId) => navigate(`/tasks/${encodeURIComponent(taskId)}`)} />
          ) : (
            <EmptyState title="No activity in this period" />
          )}
        </CardContent>
      </Card>
    </>
  );
}
