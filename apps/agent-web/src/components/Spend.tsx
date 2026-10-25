import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { formatUsd, type AgentSpend } from '@cw/shared';

/** "Max spent $3.21 of $25.00 in the last 30 days" with a bar (ADR-0029). */
export function SpendMeter({ spend, name, dense = false }: { spend: AgentSpend; name: string; dense?: boolean }) {
  const pct = Math.min(100, (spend.spentUsd / Math.max(spend.limitUsd, 0.000001)) * 100);
  const color = spend.exceeded ? 'error' : pct >= 80 ? 'warning' : 'primary';
  return (
    <Box sx={{ minWidth: dense ? 0 : 220 }}>
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography variant={dense ? 'caption' : 'body2'} color="text.secondary">
          {name} spent <b>{formatUsd(spend.spentUsd)}</b> of {formatUsd(spend.limitUsd)} in the last {spend.windowDays} days
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {spend.model}
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" value={pct} color={color} sx={{ height: 6, borderRadius: 3, mt: 0.5 }} />
      {spend.exceeded && (
        <Typography variant="caption" color="error">
          Spend limit reached — new steps are not started until an administrator raises the limit or older spend leaves the 30-day window.
        </Typography>
      )}
    </Box>
  );
}

/** Shown instead of a silent failure when no real AI model can be used. */
export function AiProblemAlert({ spend }: { spend?: AgentSpend }) {
  if (!spend || spend.ai.configured) return null;
  return (
    <Alert severity="error">
      <AlertTitle>No AI model available</AlertTitle>
      {spend.ai.problem ? `${spend.ai.problem[0]!.toUpperCase()}${spend.ai.problem.slice(1)}.` : 'The AI model is not configured.'}{' '}
      {spend.ai.howToFix ? <>An administrator must fix this: {spend.ai.howToFix}</> : null} Tasks can only run with a real model.
    </Alert>
  );
}
