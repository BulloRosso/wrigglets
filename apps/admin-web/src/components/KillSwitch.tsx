import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import EmergencyOutlined from '@mui/icons-material/EmergencyOutlined';
import { KILL_LEVELS, type KillLevel } from '@cw/shared';
import { KILL_LEVEL_META, KillSwitchChip, errorMessage, formatRelative } from '@cw/ui';
import { api, type KillSwitchEntry } from '../api';

/** Choose a kill-switch level (reason mandatory unless `normal`). */
export function KillSwitchDialog({
  open,
  title,
  current,
  onClose,
  onApply,
}: {
  open: boolean;
  title: string;
  current?: KillSwitchEntry;
  onClose: () => void;
  onApply: (level: KillLevel, reason?: string) => Promise<unknown>;
}) {
  const [level, setLevel] = useState<KillLevel>(current?.level && current.level !== 'normal' ? 'normal' : 'paused');
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => onApply(level, reason.trim() || undefined), onSuccess: () => onClose() });
  const needsReason = level !== 'normal' && !reason.trim();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {current && current.level !== 'normal' && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Currently <b>{KILL_LEVEL_META[current.level].label}</b> since {formatRelative(current.at)} by {current.by}
            {current.auto ? ` (rule ${current.auto.rule})` : ''}
            {current.reason ? ` — ${current.reason}` : ''}
          </Alert>
        )}
        <RadioGroup value={level} onChange={(e) => setLevel(e.target.value as KillLevel)}>
          {KILL_LEVELS.map((l) => (
            <FormControlLabel
              key={l}
              value={l}
              control={<Radio color={l === 'stopped' ? 'error' : l === 'normal' ? 'success' : 'warning'} />}
              sx={{ alignItems: 'flex-start', mb: 1, '& .MuiRadio-root': { pt: 0.5 } }}
              label={
                <Stack>
                  <Typography variant="subtitle2">{KILL_LEVEL_META[l].label}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {KILL_LEVEL_META[l].help}
                  </Typography>
                </Stack>
              }
            />
          ))}
        </RadioGroup>
        <TextField
          fullWidth
          sx={{ mt: 1 }}
          label={level === 'normal' ? 'Reason (optional)' : 'Reason (required, visible to users)'}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          slotProps={{ htmlInput: { maxLength: 500 } }}
        />
        {m.error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {errorMessage(m.error)}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color={level === 'normal' ? 'primary' : 'error'} disabled={needsReason || m.isPending} onClick={() => m.mutate()}>
          {level === 'normal' ? 'Lift restrictions' : `Set ${KILL_LEVEL_META[level].label.toLowerCase()}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** App-bar control for the global kill switch (applies to all agents). */
export function GlobalKillSwitch() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['killswitch'], queryFn: api.killSwitch, refetchInterval: 10_000 });
  const g = q.data?.state.global;
  const active = !!g && g.level !== 'normal';
  return (
    <>
      {active && <KillSwitchChip level={g.level} reason={g.reason} source="global" />}
      <Button
        size="small"
        variant={active ? 'contained' : 'outlined'}
        color="error"
        startIcon={<EmergencyOutlined />}
        onClick={() => setOpen(true)}
        sx={{ whiteSpace: 'nowrap' }}
      >
        Kill switch
      </Button>
      {open && (
        <KillSwitchDialog
          open
          title="Global kill switch — all agents"
          current={g}
          onClose={() => setOpen(false)}
          onApply={async (level, reason) => {
            await api.setGlobalKillSwitch(level, reason);
            await qc.invalidateQueries();
          }}
        />
      )}
    </>
  );
}
