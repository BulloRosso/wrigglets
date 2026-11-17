import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { api, type InboxItem } from '../api';

/*
 * One inbox for every decision of a person (ADR-0049): four-eyes actions, playbook steps that loosen, company-wiki
 * proposals (all ApprovalWorkflows, decided here), config pull requests (decided on the Git host) and plan approvals
 * of agent tasks (decided in the agent app). New items are mailed with a deep link to this page.
 */

const KIND: Record<InboxItem['kind'], { label: string; color: 'warning' | 'secondary' | 'info' | 'primary' | 'default' }> = {
  action: { label: 'four eyes', color: 'warning' },
  'playbook-step': { label: 'playbook step', color: 'secondary' },
  wiki: { label: 'wiki proposal', color: 'info' },
  config: { label: 'config pull request', color: 'primary' },
  plan: { label: 'task plan', color: 'default' },
};

function Item({ i, focused }: { i: InboxItem; focused: boolean }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const decide = useMutation({ mutationFn: (d: 'approve' | 'reject') => api.decideLiquidApproval(i.id, d, comment || undefined), onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-inbox'] }) });
  const detail = i.detail ?? {};
  return (
    <Card variant="outlined" sx={{ borderColor: focused ? 'primary.main' : undefined, borderWidth: focused ? 2 : 1 }}>
      <CardHeader title={i.subject} subheader={<>requested by {i.requestedBy} · <RelativeTime iso={i.createdAt} /></>} action={<Stack direction="row" spacing={1}><Chip size="small" color={KIND[i.kind].color} label={KIND[i.kind].label} /><Chip size="small" variant="outlined" label={i.state} /></Stack>} />
      <CardContent>
        <Stack spacing={1.5}>
          {typeof detail.reason === 'string' && detail.reason && detail.reason !== 'allowed' && <Typography variant="body2">{detail.reason}</Typography>}
          {detail.args != null && typeof detail.args === 'object' && Object.keys(detail.args as object).length > 0 && (
            <Box component="pre" sx={{ m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, overflowX: 'auto' }}>
              {JSON.stringify(detail.args, null, 2)}
            </Box>
          )}
          {i.decideHere ? (
            <>
              <TextField size="small" label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <ErrorAlert error={decide.error} title="Decision refused" />
              <Stack direction="row" spacing={1}>
                <Button variant="contained" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
                  Approve
                </Button>
                <Button color="error" disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
                  Reject
                </Button>
              </Stack>
            </>
          ) : (
            <Box>
              <Button variant="outlined" href={i.link} target="_blank" rel="noreferrer">
                {i.kind === 'config' ? 'Review the pull request' : 'Open in the agent'}
              </Button>
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function LiquidApprovalsPage() {
  const [params] = useSearchParams();
  const focus = params.get('focus');
  const q = useQuery({ queryKey: ['liquid-inbox'], queryFn: api.liquidInbox, refetchInterval: 5000 });
  const items = [...(q.data ?? [])].sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : 0));
  return (
    <>
      <PageHeader overline="Liquid enterprise" title="Approvals" subtitle="Every decision waiting for a person, in one place: four-eyes actions, playbook steps that loosen, wiki proposals, config pull requests, task plans." />
      <ErrorAlert error={q.error} title="Could not load the approvals" />
      {q.isLoading && <Loading />}
      {q.data && items.length === 0 && <EmptyState title="Nothing to decide" text="New requests appear here and are mailed to the approvers with a link." />}
      <Stack spacing={2}>
        {items.map((i) => (
          <Item key={i.id} i={i} focused={i.id === focus} />
        ))}
      </Stack>
    </>
  );
}
