import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BlockOutlined from '@mui/icons-material/BlockOutlined';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import LockOpenOutlined from '@mui/icons-material/LockOpenOutlined';
import { formatUsd, type AgentSummary } from '@cw/shared';
import { ConfirmDialog, ErrorAlert, KeyValueList, Loading, formatDateTime } from '@cw/ui';
import { api } from '../api';
import { ModelSelect } from './Ai';

/*
 * AI & budget of an agent (ADR-0029): model, USD spend limit and the agent's LiteLLM virtual key — all managed through
 * the LiteLLM API in the background, so admins never need the LiteLLM UI for these standard tasks.
 */

function DailyBars({ daily, limit }: { daily: Array<{ date: string; usd: number }>; limit: number }) {
  const max = Math.max(...daily.map((d) => d.usd), limit / 30, 1e-6);
  return (
    <Box>
      <Stack direction="row" spacing="2px" sx={{ alignItems: 'flex-end', height: 96, borderBottom: 1, borderColor: 'divider' }}>
        {daily.map((d) => (
          <Tooltip key={d.date} title={`${d.date}: ${formatUsd(d.usd)}`}>
            <Box sx={{ flex: 1, minWidth: 3, height: `${Math.max(d.usd > 0 ? 3 : 0, (d.usd / max) * 100)}%`, bgcolor: 'primary.main', borderRadius: '2px 2px 0 0', opacity: 0.85 }} />
          </Tooltip>
        ))}
      </Stack>
      <Stack direction="row" sx={{ justifyContent: 'space-between', mt: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          {daily[0]?.date}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          today
        </Typography>
      </Stack>
    </Box>
  );
}

export function AiBudgetTab({ a }: { a: AgentSummary }) {
  const qc = useQueryClient();
  const agentId = a.spec.agentId;
  const q = useQuery({ queryKey: ['agent-ai', agentId], queryFn: () => api.agentAi(agentId), refetchInterval: 15_000 });
  const [limit, setLimit] = useState<string>('');
  const [model, setModel] = useState<string>(a.spec.model);
  const [confirm, setConfirm] = useState<'rotate' | 'block' | undefined>();
  useEffect(() => {
    if (q.data && limit === '') setLimit(String(q.data.spend.limitUsd));
  }, [q.data, limit]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agent-ai', agentId] });
    void qc.invalidateQueries({ queryKey: ['agent', agentId] });
    void qc.invalidateQueries({ queryKey: ['ai'] });
  };
  const save = useMutation({
    mutationFn: () => api.setAgentAi(agentId, { spendLimitUsd: Number(limit), model: model !== a.spec.model ? model : undefined }),
    onSuccess: refresh,
  });
  const rotate = useMutation({ mutationFn: () => api.rotateAgentKey(agentId), onSuccess: () => (setConfirm(undefined), refresh()) });
  const block = useMutation({ mutationFn: (blocked: boolean) => api.blockAgentKey(agentId, blocked), onSuccess: () => (setConfirm(undefined), refresh()) });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  const { spend, key, keyError, daily, smallModel } = q.data;
  const pct = Math.min(100, (spend.spentUsd / Math.max(spend.limitUsd, 1e-6)) * 100);
  const limitNum = Number(limit);
  const dirty = (limit !== '' && limitNum !== spend.limitUsd) || model !== a.spec.model;

  return (
    <Grid container spacing={3}>
      {!spend.ai.configured && (
        <Grid size={{ xs: 12 }}>
          <Alert severity="error">
            {spend.ai.problem}. {spend.ai.howToFix}
          </Alert>
        </Grid>
      )}
      <Grid size={{ xs: 12, md: 7 }}>
        <Card sx={{ height: '100%' }}>
          <CardHeader title="Spend" subheader={`Rolling ${spend.windowDays} days, from LiteLLM's spend logs · cost per request at current OpenAI prices`} />
          <CardContent sx={{ pt: 0 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 1 }}>
              <Typography variant="h4">{formatUsd(spend.spentUsd)}</Typography>
              <Typography variant="body1" color="text.secondary">
                of {formatUsd(spend.limitUsd)} · {formatUsd(spend.remainingUsd)} left
              </Typography>
              {spend.exceeded && <Chip size="small" color="error" label="limit reached — no new steps" />}
            </Stack>
            <LinearProgress variant="determinate" value={pct} color={spend.exceeded ? 'error' : pct >= 80 ? 'warning' : 'primary'} sx={{ height: 8, borderRadius: 4, mb: 3 }} />
            {daily.length > 0 ? <DailyBars daily={daily} limit={spend.limitUsd} /> : <Typography variant="body2" color="text.secondary">No spend data yet.</Typography>}
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 5 }}>
        <Card sx={{ height: '100%' }}>
          <CardHeader title="Budget and model" subheader="Applied to the agent's LiteLLM key immediately" />
          <CardContent sx={{ pt: 0 }}>
            <Stack spacing={2.5}>
              <TextField
                label="Spend limit per 30 days"
                type="number"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                error={limit !== '' && (!(limitNum >= 0.5) || limitNum > 10_000)}
                helperText="Checked before every step and every chat answer; the key's LiteLLM budget is the backstop"
                slotProps={{ input: { startAdornment: <InputAdornment position="start">$</InputAdornment> }, htmlInput: { min: 0.5, max: 10_000, step: 0.5 } }}
              />
              <ModelSelect value={model} onChange={setModel} />
              {model !== a.spec.model && <Alert severity="info">Changing the model re-creates the container; running steps are retried by Temporal.</Alert>}
              <ErrorAlert error={save.error} />
              <Stack direction="row" spacing={1}>
                <Button variant="contained" onClick={() => save.mutate()} disabled={!dirty || save.isPending || !(limitNum >= 0.5)}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  disabled={!dirty || save.isPending}
                  onClick={() => {
                    setLimit(String(spend.limitUsd));
                    setModel(a.spec.model);
                  }}
                >
                  Reset
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12 }}>
        <Card>
          <CardHeader
            avatar={<KeyOutlined color="primary" />}
            title="Virtual key"
            subheader="The agent's only credential for the AI model — created and managed by the control plane through the LiteLLM API"
            action={key && <Chip color={key.blocked ? 'error' : 'success'} label={key.blocked ? 'blocked' : 'active'} sx={{ mt: 1, mr: 1 }} />}
          />
          <CardContent sx={{ pt: 0 }}>
            {keyError && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {keyError}
              </Alert>
            )}
            {key && (
              <KeyValueList
                items={[
                  ['Key', <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{key.masked}</Typography>],
                  ['Alias', key.alias ?? '–'],
                  ['Created', key.createdAt ? formatDateTime(key.createdAt) : '–'],
                  ['Allowed models', key.models.length ? key.models.join(', ') : `all (restricted to ${[a.spec.model, smallModel].join(', ')} on the next save)`],
                  ['LiteLLM budget (backstop)', `${formatUsd(key.maxBudgetUsd)} per ${key.budgetDuration ?? '–'} · ${formatUsd(key.periodSpendUsd)} spent since the last reset${key.budgetResetAt ? ` · resets ${formatDateTime(key.budgetResetAt)}` : ''}`],
                ]}
              />
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              {key?.blocked ? (
                <Button variant="outlined" color="success" startIcon={<LockOpenOutlined />} onClick={() => block.mutate(false)} disabled={block.isPending}>
                  Unblock key
                </Button>
              ) : (
                <Button variant="outlined" color="warning" startIcon={<BlockOutlined />} onClick={() => setConfirm('block')} disabled={!key || block.isPending}>
                  Block key
                </Button>
              )}
              <Button variant="outlined" startIcon={<KeyOutlined />} onClick={() => setConfirm('rotate')} disabled={rotate.isPending}>
                {key ? 'Rotate key' : 'Create key'}
              </Button>
            </Stack>
            <ErrorAlert error={rotate.error ?? block.error} />
          </CardContent>
        </Card>
      </Grid>
      <ConfirmDialog
        open={confirm === 'rotate'}
        title="Rotate the virtual key?"
        text="A new key with the same budget and models is created, the agent container is re-created with it, and the old key is deleted. Running steps are retried by Temporal."
        confirmLabel="Rotate"
        busy={rotate.isPending}
        error={rotate.error}
        onClose={() => setConfirm(undefined)}
        onConfirm={() => rotate.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'block'}
        title="Block the virtual key?"
        text="The agent can no longer call the AI model: new steps and chat answers fail with a clear message until the key is unblocked. For a full stop with paused tasks use the kill switch."
        confirmLabel="Block"
        busy={block.isPending}
        error={block.error}
        onClose={() => setConfirm(undefined)}
        onConfirm={() => block.mutate(true)}
      />
    </Grid>
  );
}
