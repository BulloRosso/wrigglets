import { useState } from 'react';
import Avatar from '@mui/material/Avatar';
import Chip, { type ChipProps } from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import ShieldOutlined from '@mui/icons-material/ShieldOutlined';
import ExtensionOffOutlined from '@mui/icons-material/ExtensionOffOutlined';
import PauseCircleOutline from '@mui/icons-material/PauseCircleOutlined';
import PowerSettingsNewOutlined from '@mui/icons-material/PowerSettingsNewOutlined';
import SmartToyOutlined from '@mui/icons-material/SmartToyOutlined';
import type { ReactElement } from 'react';
import type { AvatarMood, KillLevel } from '@cw/shared';

export const KILL_LEVEL_META: Record<KillLevel, { label: string; color: ChipProps['color']; icon: ReactElement; help: string }> = {
  normal: { label: 'Normal', color: 'success', icon: <ShieldOutlined />, help: 'No restrictions' },
  tools_off: { label: 'Tools off', color: 'warning', icon: <ExtensionOffOutlined />, help: 'MCP tools and A2A delegation are blocked; the agent keeps working on files' },
  paused: { label: 'Paused', color: 'warning', icon: <PauseCircleOutline />, help: 'No steps run; a running step is aborted and resumes later; tasks wait' },
  stopped: { label: 'Stopped', color: 'error', icon: <PowerSettingsNewOutlined />, help: 'Running tasks are cancelled and the container is stopped' },
};

/** Effective kill-switch level of an agent (or the global switch). Hidden for `normal` unless `showNormal`. */
export function KillSwitchChip({
  level,
  reason,
  source,
  size = 'small',
  showNormal = false,
}: {
  level: KillLevel;
  reason?: string;
  source?: 'global' | 'agent';
  size?: ChipProps['size'];
  showNormal?: boolean;
}) {
  if (level === 'normal' && !showNormal) return null;
  const m = KILL_LEVEL_META[level];
  const title = [m.help, reason && `Reason: ${reason}`, source === 'global' && 'Set by the global kill switch'].filter(Boolean).join(' · ');
  return (
    <Tooltip title={title}>
      <Chip size={size} color={m.color} icon={m.icon} label={source === 'global' && level !== 'normal' ? `${m.label} (global)` : m.label} variant={level === 'normal' ? 'outlined' : 'filled'} />
    </Tooltip>
  );
}

/** Generated agent portrait; falls back to a robot icon when no image exists (yet). */
export function AgentPortrait({ src, mood = 'neutral', name, size = 40, version }: { src: string | ((mood: AvatarMood) => string); mood?: AvatarMood; name: string; size?: number; version?: string | number }) {
  const [failed, setFailed] = useState<string | undefined>();
  const base = typeof src === 'function' ? src(mood) : src;
  const url = version !== undefined ? `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}` : base;
  return (
    <Avatar
      src={failed === url ? undefined : url}
      alt={`${name} (${mood})`}
      slotProps={{ img: { onError: () => setFailed(url), draggable: false } }}
      sx={{ width: size, height: size, bgcolor: failed === url ? 'primary.main' : 'transparent', '& img': { objectFit: 'contain' } }}
    >
      <SmartToyOutlined sx={{ fontSize: size * 0.6 }} />
    </Avatar>
  );
}
