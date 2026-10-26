import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import EventRepeatOutlined from '@mui/icons-material/EventRepeatOutlined';
import PersonOutline from '@mui/icons-material/PersonOutlined';
import { EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime, StatusChip } from '@cw/ui';
import { api } from '../api';
import { AgentStatusBanner } from '../components/AgentStatusBanner';
import { NewTaskForm } from '../components/NewTaskForm';

const STATUS_FILTERS: Array<[string, string]> = [
  ['', 'All'],
  ['queued,planning,running,verifying,fixing,finalizing', 'In progress'],
  ['awaiting_approval', 'Awaiting approval'],
  ['completed', 'Completed'],
  ['failed,budget_exceeded,expired', 'Failed'],
  ['rejected,cancelled', 'Rejected / cancelled'],
];

export function TasksPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [type, setType] = useState('');

  const q = useInfiniteQuery({
    queryKey: ['tasks', status, mine, type],
    queryFn: ({ pageParam }) => api.tasks({ status, requestedBy: mine ? 'me' : undefined, type, pageToken: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextPageToken,
    refetchInterval: 10_000,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const names = new Map(items.flatMap((t) => (t.requestedByName ? [[t.requestedBy, t.requestedByName] as const] : [])));

  return (
    <>
      <PageHeader title="Tasks" subtitle="Ask the agent for analyses, reports and changes. Every task is planned, approved, executed and audited." />
      <AgentStatusBanner />
      <NewTaskForm />
      <Card>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ p: 2, alignItems: { md: 'center' } }}>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, flexGrow: 1 }}>
            {STATUS_FILTERS.map(([value, label]) => (
              <Chip key={label} label={label} clickable color={status === value ? 'primary' : 'default'} variant={status === value ? 'filled' : 'outlined'} onClick={() => setStatus(value)} />
            ))}
          </Stack>
          <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value)} sx={{ minWidth: 140 }}>
            <MenuItem value="">All types</MenuItem>
            {['analysis', 'report', 'change', 'upload'].map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel control={<Switch checked={mine} onChange={(e) => setMine(e.target.checked)} />} label="Requested by me" />
        </Stack>
        <ErrorAlert error={q.error} />
        {q.isLoading ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState title="No tasks" text="Create a task above to get started." />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Task</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>Type</TableCell>
                  <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Requested by</TableCell>
                  <TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>Approved by</TableCell>
                  <TableCell>Started</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((t) => (
                  <TableRow key={t.taskId} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/tasks/${encodeURIComponent(t.taskId)}`)}>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Tooltip title={t.trigger === 'schedule' ? `Scheduled (${t.scheduleId})` : 'Requested by a person'}>
                          {t.trigger === 'schedule' ? <EventRepeatOutlined fontSize="small" color="action" /> : <PersonOutline fontSize="small" color="action" />}
                        </Tooltip>
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {t.title}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={String(t.status)} />
                    </TableCell>
                    <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>{t.type}</TableCell>
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>{t.requestedByName || names.get(t.requestedBy) || t.requestedBy}</TableCell>
                    <TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>{t.approvedBy.map((u) => names.get(u) ?? u).join(', ') || '–'}</TableCell>
                    <TableCell>
                      <RelativeTime iso={t.startTime} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {q.hasNextPage && (
          <Stack sx={{ p: 2, alignItems: 'center' }}>
            <Button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              Load more
            </Button>
          </Stack>
        )}
      </Card>
    </>
  );
}
