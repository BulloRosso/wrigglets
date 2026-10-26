import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { RestorePoint } from '@cw/shared';
import { ConfirmDialog, ErrorAlert, Loading, formatDateTime } from '@cw/ui';
import { api } from '../api';

const MAX_LABEL = 48;
const short = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL).trimEnd()}…` : s);

/** Vertical timeline of workspace states; a marker shows date/time and the start of the task title, never a commit id. */
function Marker({ p, last, onPick }: { p: RestorePoint; last: boolean; onPick: (p: RestorePoint) => void }) {
  return (
    <Box sx={{ display: 'flex', gap: 2, position: 'relative', pb: last ? 0 : 2.5 }}>
      {!last && <Box sx={{ position: 'absolute', left: 7, top: 24, bottom: -4, width: 2, bgcolor: 'divider' }} />}
      <Box
        sx={{
          flex: 'none',
          mt: 0.5,
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: 2,
          borderColor: 'primary.main',
          bgcolor: p.current ? 'primary.main' : 'background.paper',
          zIndex: 1,
        }}
      />
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">
            {formatDateTime(p.date)}
          </Typography>
          <Tooltip title={p.label} placement="top-start">
            <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
              {short(p.label)}
              {p.outcome && p.outcome !== 'completed' ? ` (${p.outcome})` : ''}
            </Typography>
          </Tooltip>
        </Box>
        {p.current ? (
          <Typography variant="caption" color="text.secondary">
            Current state
          </Typography>
        ) : (
          <Button size="small" variant="outlined" onClick={() => onPick(p)}>
            Go back to this
          </Button>
        )}
      </Box>
    </Box>
  );
}

/** Confirmation modal before the workspace is set back to `target`. */
export function RestoreConfirm({ target, onClose, onDone }: { target?: Pick<RestorePoint, 'hash' | 'date' | 'label'>; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const restore = useMutation({
    mutationFn: (hash: string) => api.restore(hash),
    onSuccess: () => {
      void qc.invalidateQueries();
      onDone?.();
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open={!!target}
      title="Go back to this state?"
      text={
        target && (
          <>
            The files in the workspace will be set back to how they were on <b>{formatDateTime(target.date)}</b> ({target.label}). Changes made by later tasks will no longer be visible in the files, but
            they stay in the history.
          </>
        )
      }
      confirmLabel="Restore"
      confirmColor="warning"
      busy={restore.isPending}
      error={restore.error}
      onConfirm={() => target && restore.mutate(target.hash)}
      onClose={() => {
        restore.reset();
        onClose();
      }}
    />
  );
}

export function RestoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [target, setTarget] = useState<RestorePoint>();
  const points = useQuery({ queryKey: ['restore-points'], queryFn: api.restorePoints, enabled: open });
  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
        <DialogTitle>Restore earlier state</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Each marker is the state of the workspace after a task. Newest first. Going back keeps the full history, so you can return to a later state afterwards.
          </Typography>
          {points.isLoading && <Loading />}
          <ErrorAlert error={points.error} />
          {points.data?.map((p, i) => <Marker key={p.hash} p={p} last={i === points.data.length - 1} onPick={setTarget} />)}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
      <RestoreConfirm target={target} onClose={() => setTarget(undefined)} onDone={onClose} />
    </>
  );
}
