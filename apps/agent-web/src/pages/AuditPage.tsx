import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import { EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime, StatusChip } from '@cw/ui';
import { api } from '../api';
import { CommitList } from '../components/CommitList';

/** Audit search across tasks (visibility + permanent audit exports) and commits (spec §11.1 #6). */
export function AuditPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ q: '', person: '', path: '', from: '', to: '' });
  const search = useMutation({
    mutationFn: () =>
      api.auditSearch(
        Object.fromEntries(
          Object.entries({ ...form, from: form.from ? new Date(form.from).toISOString() : '', to: form.to ? new Date(form.to).toISOString() : '' }).filter(([, v]) => v),
        ) as Record<string, string>,
      ),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <PageHeader title="Audit" subtitle="Find out who requested what, who approved it, when, and what exactly changed." />
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack
            component="form"
            direction={{ xs: 'column', md: 'row' }}
            spacing={2}
            onSubmit={(e) => {
              e.preventDefault();
              search.mutate();
            }}
          >
            <TextField label="Text (title, content, comments)" value={form.q} onChange={set('q')} sx={{ flex: 2 }} />
            <TextField label="Person (e-mail)" value={form.person} onChange={set('person')} sx={{ flex: 1 }} />
            <TextField label="Path" value={form.path} onChange={set('path')} sx={{ flex: 1 }} />
            <TextField type="date" label="From" value={form.from} onChange={set('from')} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField type="date" label="To" value={form.to} onChange={set('to')} slotProps={{ inputLabel: { shrink: true } }} />
            <Button type="submit" variant="contained" startIcon={<SearchOutlined />} disabled={search.isPending}>
              Search
            </Button>
          </Stack>
        </CardContent>
      </Card>
      <ErrorAlert error={search.error} />
      {search.isPending && <Loading label="Searching…" />}
      {search.data && (
        <Stack spacing={3}>
          <Card>
            <CardHeader title="Tasks" subheader={`${search.data.tasks.length} result(s)`} />
            {search.data.tasks.length === 0 ? (
              <EmptyState title="No matching tasks" />
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Task</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Requested by</TableCell>
                    <TableCell>Approved by</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell>Source</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {search.data.tasks.map((t) => (
                    <TableRow key={t.taskId} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/tasks/${encodeURIComponent(t.taskId)}`)}>
                      <TableCell>{t.title}</TableCell>
                      <TableCell>
                        <StatusChip status={t.status} />
                      </TableCell>
                      <TableCell>{t.requestedBy}</TableCell>
                      <TableCell>{t.approvedBy.join(', ') || '–'}</TableCell>
                      <TableCell>
                        <RelativeTime iso={t.startTime} />
                      </TableCell>
                      <TableCell>
                        <Chip size="small" variant="outlined" label={t.source === 'audit-export' ? 'audit export' : 'Temporal'} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Commits" subheader={`${search.data.commits.length} result(s) — commit messages and content changes`} />
            <CardContent sx={{ pt: 0 }}>
              <CommitList commits={search.data.commits} />
            </CardContent>
          </Card>
        </Stack>
      )}
    </>
  );
}
