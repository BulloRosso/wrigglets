import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import { alpha } from '@mui/material/styles';
import type { SvgIconComponent } from '@mui/icons-material';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import NotificationsOutlined from '@mui/icons-material/NotificationsOutlined';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutline from '@mui/icons-material/ErrorOutlined';
import GppMaybeOutlined from '@mui/icons-material/GppMaybeOutlined';
import AlarmOutlined from '@mui/icons-material/AlarmOutlined';
import BlockOutlined from '@mui/icons-material/BlockOutlined';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import HourglassEmptyOutlined from '@mui/icons-material/HourglassEmptyOutlined';
import PaymentsOutlined from '@mui/icons-material/PaymentsOutlined';
import { EmptyState, formatRelative } from '@cw/ui';
import { api } from '../api';

const KIND: Record<string, string> = {
  approval_requested: 'Approval needed',
  approval_reminder: 'Reminder: approval pending',
  completed: 'Completed',
  failed: 'Failed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
  budget_exceeded: 'Budget exceeded',
};
type Tone = 'success' | 'error' | 'warning' | 'info' | 'default';
const STYLE: Record<string, { icon: SvgIconComponent; tone: Tone }> = {
  approval_requested: { icon: GppMaybeOutlined, tone: 'warning' },
  approval_reminder: { icon: AlarmOutlined, tone: 'warning' },
  completed: { icon: CheckCircleOutline, tone: 'success' },
  failed: { icon: ErrorOutline, tone: 'error' },
  rejected: { icon: BlockOutlined, tone: 'error' },
  cancelled: { icon: CancelOutlined, tone: 'default' },
  expired: { icon: HourglassEmptyOutlined, tone: 'default' },
  budget_exceeded: { icon: PaymentsOutlined, tone: 'error' },
};
const SEEN_KEY = 'cw.notifications.seen';

export function NotificationsButton() {
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(SEEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const q = useQuery({ queryKey: ['notifications'], queryFn: api.notifications, refetchInterval: 30_000 });
  const items = q.data ?? [];
  const unread = items.filter((n) => n.at > seen).length;
  // Snapshot of "seen" taken when the popover opens, so new items stay highlighted while it is open.
  const [openedSeen, setOpenedSeen] = useState('');

  useEffect(() => {
    if (!anchor || !items[0]) return;
    setSeen(items[0].at);
    try {
      localStorage.setItem(SEEN_KEY, items[0].at);
    } catch {
      /* ignore */
    }
  }, [anchor, items]);

  return (
    <>
      <Tooltip title="Notifications">
        <IconButton onClick={(e) => {
            setOpenedSeen(seen);
            setAnchor(e.currentTarget);
          }} aria-label={`Notifications (${unread} new)`}>
          <Badge badgeContent={unread} color="error">
            <NotificationsOutlined />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Notifications
          </Typography>
          {items.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              {items.filter((n) => n.at > openedSeen).length} new
            </Typography>
          )}
        </Box>
        {items.length === 0 ? (
          <EmptyState title="Nothing new" text="You will be notified about approvals and finished tasks." />
        ) : (
          <List disablePadding sx={{ width: 380, maxWidth: '90vw', maxHeight: 440, overflow: 'auto' }}>
            {items.map((n) => {
              const st = STYLE[n.kind] ?? { icon: NotificationsOutlined, tone: 'info' as Tone };
              const Icon = st.icon;
              const isNew = n.at > openedSeen;
              return (
                <ListItemButton
                  key={n.id}
                  alignItems="flex-start"
                  sx={(t) => ({
                    gap: 0,
                    py: 1.25,
                    borderLeft: 3,
                    borderColor: isNew && st.tone !== 'default' ? `${st.tone}.main` : 'transparent',
                    bgcolor: isNew ? alpha(t.palette.primary.main, 0.05) : undefined,
                  })}
                  onClick={() => {
                    setAnchor(null);
                    navigate(`/tasks/${encodeURIComponent(n.taskId)}`);
                  }}
                >
                  <ListItemAvatar sx={{ minWidth: 48 }}>
                    <Avatar
                      sx={(t) => {
                        const c = st.tone === 'default' ? t.palette.text.secondary : t.palette[st.tone].main;
                        return { width: 36, height: 36, bgcolor: alpha(c, 0.14), color: c };
                      }}
                    >
                      <Icon fontSize="small" />
                    </Avatar>
                  </ListItemAvatar>
                  <ListItemText
                    primary={n.title ?? n.taskId}
                    secondary={
                      <>
                        <Box component="span" sx={{ color: st.tone === 'default' ? 'text.secondary' : `${st.tone}.main`, fontWeight: 600 }}>
                          {KIND[n.kind] ?? n.kind}
                        </Box>
                        {` · ${formatRelative(n.at)}`}
                        {n.text && (
                          <Box component="span" sx={{ display: 'block' }}>
                            {n.text}
                          </Box>
                        )}
                      </>
                    }
                    slotProps={{
                      primary: { noWrap: true, sx: { fontWeight: isNew ? 600 : 500 } },
                      secondary: { component: 'div', variant: 'caption', sx: { overflowWrap: 'anywhere' } },
                    }}
                    sx={{ m: 0 }}
                  />
                </ListItemButton>
              );
            })}
          </List>
        )}
      </Popover>
    </>
  );
}
