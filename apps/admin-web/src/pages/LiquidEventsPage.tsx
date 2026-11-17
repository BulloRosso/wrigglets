import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { usePaged } from '../components/Sections';
import { api, type LiquidEvent } from '../api';

/*
 * The event log as the one source of truth (ADR-0049): business events of the ontology, policy decisions, approvals,
 * playbook steps, reconcile runs, admin actions, the gateway's tool calls and the agents' application audit — one store,
 * one query.
 */

const GROUPS: Record<string, string> = {
  AdminAction: 'audit',
  GatewayToolCall: 'audit',
  AgentAppAction: 'audit',
  PolicyDecision: 'policy',
  ActionApprovalRequested: 'approval',
  PlaybookRunStarted: 'playbook',
  PlaybookStepExecuted: 'playbook',
  PlaybookStepAwaitingApproval: 'playbook',
  PlaybookStepDecided: 'playbook',
  PlaybookRunFinished: 'playbook',
  ConfigReconciled: 'config',
  OntologyVersionApplied: 'config',
};
const COLOR: Record<string, 'default' | 'primary' | 'secondary' | 'warning' | 'error' | 'info' | 'success'> = { audit: 'default', policy: 'error', approval: 'warning', playbook: 'secondary', config: 'info' };

function summary(e: LiquidEvent): string {
  const p = e.payload as Record<string, unknown>;
  if (e.type === 'GatewayToolCall') return `${String(p.outcome)}${p.reason ? `: ${String(p.reason)}` : ''}${p.policyReason ? ` (policy: ${String(p.policyReason)})` : ''}`;
  if (e.type === 'AdminAction' || e.type === 'AgentAppAction') return `${String(p.action)} ${String(p.target ?? '')}`;
  if (e.type === 'PolicyDecision') return String(p.reason ?? '');
  if (e.type === 'PlaybookStepExecuted') return `${String(p.step)} (${String(p.type)}): ${String(p.summary ?? '')}`;
  if (e.type === 'ConfigReconciled') return ((p.changes as string[] | undefined) ?? []).join('; ') || ((p.errors as Array<{ message: string }> | undefined) ?? []).map((x) => x.message).join('; ');
  if (Array.isArray(p.changes)) return `${(p.changes as unknown[]).length} object change(s)${p.result ? '' : ''}`;
  return Object.keys(p).slice(0, 5).join(', ');
}

export function LiquidEventsPage() {
  // filters can come from a link (?types=&actor=&q=&since=, e.g. from the tutorial); typing does not rewrite the URL
  const [params] = useSearchParams();
  const [type, setType] = useState(params.get('types') ?? '');
  const [actor, setActor] = useState(params.get('actor') ?? '');
  const [text, setText] = useState(params.get('q') ?? '');
  const [since, setSince] = useState(params.get('since') ?? '');
  const [open, setOpen] = useState<number | undefined>();
  const q = useQuery({ queryKey: ['liquid-events', type, actor, text, since], queryFn: () => api.liquidEvents({ types: type, actor, q: text, since, limit: since ? '500' : '200' }), refetchInterval: 5000 });
  const paged = usePaged(q.data?.events ?? [], 25);
  return (
    <>
      <PageHeader overline="Liquid enterprise" title="Event log" subtitle="One store for everything that happened: business events, policy decisions, approvals, playbook steps, reconcile runs, admin actions, tool calls, agent audit." />
      <ErrorAlert error={q.error} title="Could not query the event log" />
      <Card variant="outlined">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
          <TextField size="small" select label="Type" value={type} onChange={(e) => setType(e.target.value)} sx={{ minWidth: 260 }}>
            <MenuItem value="">all types</MenuItem>
            {(q.data?.types ?? []).map((t) => (
              <MenuItem key={t.type} value={t.type}>
                {t.type} ({t.n})
              </MenuItem>
            ))}
          </TextField>
          <TextField size="small" label="Actor (agent or person)" value={actor} onChange={(e) => setActor(e.target.value)} />
          <TextField size="small" label="Search in the payload" value={text} onChange={(e) => setText(e.target.value)} sx={{ flex: 1 }} />
          {since && <Chip label={`since ${new Date(since).toLocaleString()}`} onDelete={() => setSince('')} sx={{ alignSelf: 'center' }} />}
        </Stack>
        {q.isLoading && <Loading />}
        {q.data && q.data.events.length === 0 && <EmptyState title="No events" text="Nothing matches the filter." />}
        {q.data && q.data.events.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>When</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Object</TableCell>
                <TableCell>Actor</TableCell>
                <TableCell>Summary</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {paged.rows.map((e) => (
                <Fragment key={e.seq}>
                  <TableRow hover onClick={() => setOpen(open === e.seq ? undefined : e.seq)} sx={{ cursor: 'pointer' }}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{e.seq}</TableCell>
                    <TableCell>
                      <RelativeTime iso={e.occurred_at} />
                    </TableCell>
                    <TableCell>
                      <Chip size="small" variant="outlined" color={COLOR[GROUPS[e.type] ?? ''] ?? 'primary'} label={e.type} />
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {e.object_type}:{e.object_id}
                    </TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{[e.actor_agent, e.actor_user].filter(Boolean).join(' · ') || '—'}</TableCell>
                    <TableCell sx={{ fontSize: 12, maxWidth: 420 }}>
                      <Typography variant="caption" noWrap component="div">
                        {summary(e)}
                      </Typography>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={6} sx={{ py: 0, borderBottom: open === e.seq ? undefined : 'none' }}>
                      <Collapse in={open === e.seq} unmountOnExit>
                        <Box component="pre" sx={{ fontSize: 11, m: 1, p: 1, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', maxHeight: 360 }}>
                          {JSON.stringify(e, null, 2)}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
        {paged.pager}
      </Card>
    </>
  );
}
