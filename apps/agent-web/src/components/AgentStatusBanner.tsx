import { Link as RouterLink } from 'react-router';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import { AgentPortrait, KILL_LEVEL_META, formatRelative } from '@cw/ui';
import { agentMood, avatarUrl, useAgentStatus } from '../api';

/** "Idle / working on X / N waiting" (spec §11.1), the agent's portrait and the kill-switch state (ADR-0022). */
export function AgentStatusBanner() {
  const q = useAgentStatus();
  const s = q.data;
  if (!s) return null;
  const harnessDown = s.health.harness.state !== 'up';
  const ks = s.killSwitch && s.killSwitch.level !== 'normal' ? s.killSwitch : undefined;
  return (
    <Stack spacing={2} sx={{ mb: 3 }}>
      {ks && (
        <Alert severity={ks.level === 'tools_off' ? 'warning' : 'error'} icon={KILL_LEVEL_META[ks.level].icon}>
          <AlertTitle>
            {KILL_LEVEL_META[ks.level].label} by {ks.by} {formatRelative(ks.at)}
          </AlertTitle>
          {ks.reason ? `Reason: ${ks.reason}. ` : ''}
          {KILL_LEVEL_META[ks.level].help}.
        </Alert>
      )}
      <Alert
        severity={s.health.status !== 'ok' || harnessDown ? 'warning' : s.holder ? 'info' : 'success'}
        variant="outlined"
        icon={<AgentPortrait src={avatarUrl} mood={agentMood(s)} name={s.displayName} size={56} />}
        sx={{ alignItems: 'center' }}
      >
        <Box>
          <AlertTitle>
            {s.holder ? (
              <>
                {s.displayName} is working on{' '}
                <Link component={RouterLink} to={`/tasks/${encodeURIComponent(s.holder.taskId)}`}>
                  {s.holder.title ?? s.holder.taskId}
                </Link>
              </>
            ) : (
              `${s.displayName} is idle`
            )}
          </AlertTitle>
          {s.holder && `Started ${formatRelative(s.holder.since)}. `}
          {s.waiting.length > 0 ? `${s.waiting.length} task(s) waiting for the workspace.` : 'No tasks waiting.'}
          {harnessDown && ` Agent Harness: ${s.health.harness.state}.`}
          {s.health.temporal.state !== 'up' && ' Temporal is unreachable.'}
        </Box>
      </Alert>
    </Stack>
  );
}
