import { useQuery } from '@tanstack/react-query';
import Card from '@mui/material/Card';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { EmptyState, ErrorAlert, Loading, PageHeader, formatDateTime } from '@cw/ui';
import { api } from '../api';

export function AuditPage() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(), refetchInterval: 15_000 });
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
                {q.data.map((e, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.at)}</TableCell>
                    <TableCell>{e.by}</TableCell>
                    <TableCell>{e.action}</TableCell>
                    <TableCell>{e.target}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 420, overflowWrap: 'anywhere' }}>{e.details ? JSON.stringify(e.details) : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
    </>
  );
}
