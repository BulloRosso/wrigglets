import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import NotificationsOutlined from '@mui/icons-material/NotificationsOutlined';
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
        <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label={`Notifications (${unread} new)`}>
          <Badge badgeContent={unread} color="error">
            <NotificationsOutlined />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <Typography variant="subtitle2" sx={{ px: 2, pt: 1.5 }}>
          Notifications
        </Typography>
        {items.length === 0 ? (
          <EmptyState title="Nothing new" text="You will be notified about approvals and finished tasks." />
        ) : (
          <List dense sx={{ width: 360, maxWidth: '90vw', maxHeight: 420, overflow: 'auto' }}>
            {items.map((n) => (
              <ListItemButton
                key={n.id}
                onClick={() => {
                  setAnchor(null);
                  navigate(`/tasks/${encodeURIComponent(n.taskId)}`);
                }}
              >
                <ListItemText primary={`${KIND[n.kind] ?? n.kind}: ${n.title ?? n.taskId}`} secondary={`${formatRelative(n.at)}${n.text ? ` · ${n.text}` : ''}`} slotProps={{ secondary: { noWrap: true } }} />
              </ListItemButton>
            ))}
          </List>
        )}
      </Popover>
    </>
  );
}
