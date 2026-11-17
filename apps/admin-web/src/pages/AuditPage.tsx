import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import TextField from '@mui/material/TextField';
import Card from '@mui/material/Card';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { EmptyState, ErrorAlert, Loading, PageHeader, formatDateTime } from '@cw/ui';
import { api } from '../api';
import { usePaged } from '../components/Sections';

/** Admin actions, newest first, filterable and paged (UI review ADM-08: the page used to render every entry at once). */
export function AuditPage() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(), refetchInterval: 15_000 });
  const [text, setText] = useState('');
  const t = text.trim().toLowerCase();
  const filtered = (q.data ?? []).filter((e) => !t || `${e.by} ${e.action} ${e.target} ${e.details ? JSON.stringify(e.details) : ''}`.toLowerCase().includes(t));
  const { rows, pager } = usePaged(filtered, 50);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Administrative actions on the platform (agent lifecycle, users, access). Agent work is audited in each agent." />
      <ErrorAlert error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.length ? (
        <EmptyState title="No admin actions yet" />
      ) : (
        <Card>
          <TextField size="small" label="Filter (person, action, target, details)" value={text} onChange={(e) => setText(e.target.value)} sx={{ m: 1.5, minWidth: 360 }} />
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>When</TableCell>
                  <TableCell>Who</TableCell>
                  <TableCell>Action</TableCell>
                  <TableCell>Target</TableCell>
                  <TableCell>Details</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((e, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.at)}</TableCell>
                    <TableCell>{e.by}</TableCell>
                    <TableCell>{e.action}</TableCell>
                    <TableCell>{e.target}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.details ? JSON.stringify(e.details, null, 2) : undefined}>
                      {e.details ? JSON.stringify(e.details) : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {pager}
        </Card>
      )}
    </>
  );
}
