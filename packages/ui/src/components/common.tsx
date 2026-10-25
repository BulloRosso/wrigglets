import { useEffect, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import InboxOutlined from '@mui/icons-material/InboxOutlined';
import { errorMessage } from '../api';
import { formatDateTime, formatRelative } from '../format';

export function PageHeader({ title, subtitle, actions, overline }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; overline?: ReactNode }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 3, alignItems: { sm: 'flex-end' }, justifyContent: 'space-between' }}>
      <Box sx={{ minWidth: 0 }}>
        {overline && (
          <Typography variant="overline" color="text.secondary" component="div">
            {overline}
          </Typography>
        )}
        <Typography variant="h4" component="h1" sx={{ wordBreak: 'break-word' }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions && (
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0, flexWrap: 'wrap', rowGap: 1 }}>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}

export function EmptyState({ title, text, action, icon }: { title: string; text?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <Stack spacing={1} sx={{ alignItems: 'center', textAlign: 'center', py: 6, px: 2, color: 'text.secondary' }}>
      <Box sx={{ fontSize: 48, lineHeight: 1, opacity: 0.6 }}>{icon ?? <InboxOutlined fontSize="inherit" />}</Box>
      <Typography variant="subtitle1" color="text.primary">
        {title}
      </Typography>
      {text && <Typography variant="body2">{text}</Typography>}
      {action}
    </Stack>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'center', py: 6, color: 'text.secondary' }}>
      <CircularProgress size={22} />
      <Typography variant="body2">{label}</Typography>
    </Stack>
  );
}

export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  return (
    <Alert severity="error" sx={{ my: 2 }}>
      {title ? <strong>{title}: </strong> : null}
      {errorMessage(error)}
    </Alert>
  );
}

export function RelativeTime({ iso }: { iso?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <>–</>;
  return (
    <Tooltip title={formatDateTime(iso)}>
      <Box component="time" dateTime={iso} sx={{ whiteSpace: 'nowrap' }}>
        {formatRelative(iso)}
      </Box>
    </Tooltip>
  );
}

export function KeyValueList({ items, dense }: { items: Array<[ReactNode, ReactNode]>; dense?: boolean }) {
  return (
    <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(120px, max-content) 1fr' }, columnGap: 3, rowGap: dense ? 0.75 : 1.25, m: 0 }}>
      {items.map(([k, v], i) => (
        <Box key={i} sx={{ display: 'contents' }}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {k}
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
            {v}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  text?: ReactNode;
  confirmLabel: string;
  confirmColor?: 'primary' | 'error' | 'warning' | 'success';
  /** Show a comment field; `required` makes it mandatory. */
  comment?: { label: string; required?: boolean };
  busy?: boolean;
  error?: unknown;
  children?: ReactNode;
  onConfirm: (comment: string) => void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, text, confirmLabel, confirmColor = 'primary', comment, busy, error, children, onConfirm, onClose }: ConfirmDialogProps) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (open) setValue('');
  }, [open]);
  const invalid = !!comment?.required && !value.trim();
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {text && <DialogContentText component="div">{text}</DialogContentText>}
        {children}
        {comment && (
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            sx={{ mt: 2 }}
            label={comment.label}
            required={comment.required}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <ErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" color={confirmColor} disabled={busy || invalid} onClick={() => onConfirm(value.trim())}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
