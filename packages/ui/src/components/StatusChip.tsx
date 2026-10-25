import Chip, { type ChipProps } from '@mui/material/Chip';
import HourglassEmptyOutlined from '@mui/icons-material/HourglassEmptyOutlined';
import EditNoteOutlined from '@mui/icons-material/EditNoteOutlined';
import HowToVoteOutlined from '@mui/icons-material/HowToVoteOutlined';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutlined';
import FactCheckOutlined from '@mui/icons-material/FactCheckOutlined';
import BuildOutlined from '@mui/icons-material/BuildOutlined';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutlined';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import ErrorOutline from '@mui/icons-material/ErrorOutlineOutlined';
import BlockOutlined from '@mui/icons-material/BlockOutlined';
import TimerOffOutlined from '@mui/icons-material/TimerOffOutlined';
import SavingsOutlined from '@mui/icons-material/SavingsOutlined';
import ArchiveOutlined from '@mui/icons-material/ArchiveOutlined';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import HelpOutline from '@mui/icons-material/HelpOutlineOutlined';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import PauseCircleOutline from '@mui/icons-material/PauseCircleOutlined';
import ForwardToInboxOutlined from '@mui/icons-material/ForwardToInboxOutlined';
import type { ReactElement } from 'react';

type Color = ChipProps['color'];

const STATUS: Record<string, { label: string; color: Color; icon: ReactElement }> = {
  queued: { label: 'Queued', color: 'default', icon: <HourglassEmptyOutlined /> },
  planning: { label: 'Planning', color: 'info', icon: <EditNoteOutlined /> },
  awaiting_approval: { label: 'Awaiting approval', color: 'warning', icon: <HowToVoteOutlined /> },
  running: { label: 'Running', color: 'info', icon: <PlayCircleOutline /> },
  verifying: { label: 'Verifying', color: 'info', icon: <FactCheckOutlined /> },
  fixing: { label: 'Fixing', color: 'info', icon: <BuildOutlined /> },
  finalizing: { label: 'Finalizing', color: 'info', icon: <SyncOutlined /> },
  suspended: { label: 'Suspended', color: 'warning', icon: <PauseCircleOutline /> },
  awaiting_delegations: { label: 'Waiting for colleagues', color: 'info', icon: <ForwardToInboxOutlined /> },
  completed: { label: 'Completed', color: 'success', icon: <CheckCircleOutline /> },
  rejected: { label: 'Rejected', color: 'default', icon: <BlockOutlined /> },
  cancelled: { label: 'Cancelled', color: 'default', icon: <CancelOutlined /> },
  failed: { label: 'Failed', color: 'error', icon: <ErrorOutline /> },
  budget_exceeded: { label: 'Budget exceeded', color: 'error', icon: <SavingsOutlined /> },
  expired: { label: 'Expired', color: 'default', icon: <TimerOffOutlined /> },
  archived: { label: 'Archived', color: 'default', icon: <ArchiveOutlined /> },
  // runtime states (admin console)
  starting: { label: 'Starting', color: 'info', icon: <SyncOutlined /> },
  stopped: { label: 'Stopped', color: 'default', icon: <StopCircleOutlined /> },
  restarting: { label: 'Restarting', color: 'warning', icon: <SyncOutlined /> },
  missing: { label: 'Not deployed', color: 'default', icon: <HelpOutline /> },
  up: { label: 'Up', color: 'success', icon: <CheckCircleOutline /> },
  down: { label: 'Down', color: 'error', icon: <ErrorOutline /> },
  ok: { label: 'Healthy', color: 'success', icon: <CheckCircleOutline /> },
  degraded: { label: 'Degraded', color: 'warning', icon: <ErrorOutline /> },
};

export const statusLabel = (s: string) => STATUS[s]?.label ?? s.replace(/_/g, ' ');

export function StatusChip({ status, size = 'small', variant }: { status: string; size?: ChipProps['size']; variant?: ChipProps['variant'] }) {
  const s = STATUS[status] ?? { label: status.replace(/_/g, ' '), color: 'default' as Color, icon: <HelpOutline /> };
  return <Chip size={size} color={s.color} icon={s.icon} label={s.label} variant={variant ?? (s.color === 'default' ? 'outlined' : 'filled')} />;
}
