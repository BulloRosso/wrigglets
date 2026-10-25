import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField, { type TextFieldProps } from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import { formatUsd, type AiModelInfo } from '@cw/shared';
import { Loading, StatusChip, formatNumber } from '@cw/ui';
import { api } from '../api';

/* AI gateway (LiteLLM → OpenAI): status, prices, spend per agent (ADR-0029). */

export const useAi = () => useQuery({ queryKey: ['ai'], queryFn: () => api.ai(), refetchInterval: 30_000 });

const price = (m: AiModelInfo) =>
  m.inputUsdPer1M !== undefined ? `$${m.inputUsdPer1M} in · $${m.outputUsdPer1M} out per 1M tokens` : 'price unknown';

export function ModelSelect({ value, onChange, allowDefault, ...rest }: { value: string; onChange: (v: string) => void; allowDefault?: boolean } & Omit<TextFieldProps, 'onChange' | 'value'>) {
  const ai = useAi();
  const models = ai.data?.status.models ?? [];
  const known = models.some((m) => m.name === value) || (allowDefault && !value);
  return (
    <TextField
      select
      label="Model"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      helperText={known ? 'Models configured in LiteLLM (infra/litellm/config.yaml), with current OpenAI prices' : `"${value}" is not configured in LiteLLM`}
      error={!known}
      slotProps={{ select: { displayEmpty: allowDefault }, inputLabel: { shrink: true } }}
      {...rest}
    >
      {allowDefault && <MenuItem value="">Platform default ({ai.data?.status.defaultModel ?? '…'})</MenuItem>}
      {!known && value && <MenuItem value={value}>{value} (not configured)</MenuItem>}
      {models.map((m) => (
        <MenuItem key={m.name} value={m.name}>
          <Stack>
            <span>{m.name}</span>
            <Typography variant="caption" color="text.secondary">
              {price(m)}
            </Typography>
          </Stack>
        </MenuItem>
      ))}
    </TextField>
  );
}

/** Loud, actionable message when no real model can be used. */
export function AiNotConfiguredAlert() {
  const ai = useAi();
  const s = ai.data?.status;
  if (!s || s.configured) return null;
  return (
    <Alert severity="error" sx={{ mb: 3 }}>
      <AlertTitle>No AI model available — agents cannot work</AlertTitle>
      {s.problem ? `${s.problem[0]!.toUpperCase()}${s.problem.slice(1)}.` : ''} <b>To fix:</b> {s.howToFix}
    </Alert>
  );
}

export function AiGatewayCard() {
  const ai = useAi();
  if (ai.isLoading) return <Loading />;
  if (!ai.data) return null;
  const { status, agents } = ai.data;
  return (
    <Card>
      <CardHeader
        title="AI gateway"
        subheader="LiteLLM 1.102.0 → OpenAI · each agent has its own virtual key with a USD spend limit per 30 days"
        action={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <StatusChip status={status.configured ? 'ok' : status.reachable ? 'degraded' : 'down'} />
            {status.gatewayUrl && (
              <Button size="small" endIcon={<OpenInNewOutlined />} href={status.gatewayUrl} target="_blank" rel="noreferrer">
                LiteLLM
              </Button>
            )}
          </Stack>
        }
      />
      <CardContent sx={{ pt: 0 }}>
        {!status.configured && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {status.problem}. {status.howToFix}
          </Alert>
        )}
        <Typography variant="subtitle2" gutterBottom>
          Models and current prices (USD per 1M tokens)
        </Typography>
        <Table size="small" sx={{ mb: 3 }}>
          <TableHead>
            <TableRow>
              <TableCell>Model</TableCell>
              <TableCell align="right">Input</TableCell>
              <TableCell align="right">Cached input</TableCell>
              <TableCell align="right">Output</TableCell>
              <TableCell align="right">Context</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {status.models.map((m) => (
              <TableRow key={m.name}>
                <TableCell>
                  {m.name}
                  {m.name === status.defaultModel && <Typography component="span" variant="caption" color="text.secondary"> · default</Typography>}
                </TableCell>
                <TableCell align="right">{m.inputUsdPer1M !== undefined ? `$${m.inputUsdPer1M}` : '–'}</TableCell>
                <TableCell align="right">{m.cachedInputUsdPer1M !== undefined ? `$${m.cachedInputUsdPer1M}` : '–'}</TableCell>
                <TableCell align="right">{m.outputUsdPer1M !== undefined ? `$${m.outputUsdPer1M}` : '–'}</TableCell>
                <TableCell align="right">{m.contextTokens ? formatNumber(m.contextTokens) : '–'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Typography variant="subtitle2" gutterBottom>
          Spend per agent (last 30 days)
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Agent</TableCell>
              <TableCell>Model</TableCell>
              <TableCell sx={{ width: '45%' }}>Spent / limit</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {agents.map((a) => {
              const pct = Math.min(100, (a.spentUsd / Math.max(a.limitUsd, 1e-6)) * 100);
              return (
                <TableRow key={a.agentId}>
                  <TableCell>{a.agentId}</TableCell>
                  <TableCell>{a.model}</TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {formatUsd(a.spentUsd)} / {formatUsd(a.limitUsd)}
                      {a.exceeded && ' — limit reached'}
                    </Typography>
                    <LinearProgress variant="determinate" value={pct} color={a.exceeded ? 'error' : pct >= 80 ? 'warning' : 'primary'} sx={{ height: 6, borderRadius: 3 }} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
