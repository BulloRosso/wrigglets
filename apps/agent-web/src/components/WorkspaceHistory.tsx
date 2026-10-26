import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutline from '@mui/icons-material/ErrorOutlined';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import HourglassEmpty from '@mui/icons-material/HourglassEmpty';
import EditOutlined from '@mui/icons-material/EditOutlined';
import BlockOutlined from '@mui/icons-material/BlockOutlined';
import type { WorkspaceChange } from '@cw/shared';
import { RelativeTime, formatDateTime } from '@cw/ui';
import { DiffDialog } from './CommitList';
import { RestoreConfirm } from './RestoreDialog';

const FILES_SHOWN = 3;

type Look = { label?: string; color: 'success' | 'error' | 'warning' | 'info' | 'default'; icon: typeof CheckCircleOutline };

function look(c: WorkspaceChange): Look {
  if (c.kind === 'restore') return { color: 'default', icon: HistoryOutlined };
  if (c.kind === 'edit' || c.kind === 'start') return { color: 'default', icon: EditOutlined };
  switch (c.status) {
    case 'completed':
      return { label: 'Done', color: 'success', icon: CheckCircleOutline };
    case 'failed':
    case 'budget_exceeded':
      return { label: c.status === 'failed' ? 'Failed' : 'Budget reached', color: 'error', icon: ErrorOutline };
    case 'cancelled':
    case 'rejected':
    case 'expired':
      return { label: c.status === 'rejected' ? 'Rejected' : c.status === 'expired' ? 'Expired' : 'Cancelled', color: 'warning', icon: BlockOutlined };
    case undefined:
      return { color: 'default', icon: CheckCircleOutline };
    default:
      return { label: 'In progress', color: 'info', icon: HourglassEmpty };
  }
}

const fileLabel = (f: string) => f.split('/').pop() ?? f;

function Entry({ c, onRestore, onDiff }: { c: WorkspaceChange; onRestore: (c: WorkspaceChange) => void; onDiff: (hash: string) => void }) {
  const [allFiles, setAllFiles] = useState(false);
  const [details, setDetails] = useState(false);
  const l = look(c);
  const Icon = l.icon;
  const files = allFiles ? c.files : c.files.slice(0, FILES_SHOWN);
  const who = [c.requestedBy && c.requestedBy !== 'system' ? `requested by ${c.requestedBy}` : undefined, c.approvedBy.length ? `approved by ${c.approvedBy.join(', ')}` : undefined].filter(Boolean);
  return (
    <Box sx={{ display: 'flex', gap: 2, py: 2, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
      <Icon color={l.color === 'default' ? 'action' : l.color} sx={{ mt: 0.25 }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
          {c.taskId ? (
            <Link component={RouterLink} to={`/tasks/${encodeURIComponent(c.taskId)}`} underline="hover" color="text.primary" sx={{ fontWeight: 600 }}>
              {c.title}
            </Link>
          ) : (
            <Typography sx={{ fontWeight: 600 }}>{c.title}</Typography>
          )}
          {l.label && <Chip size="small" color={l.color} variant="outlined" label={l.label} />}
          {c.current && <Chip size="small" color="primary" label="Current state" />}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          <Tooltip title={formatDateTime(c.at)}>
            <span>
              <RelativeTime iso={c.at} />
            </span>
          </Tooltip>
          {who.length > 0 && ` · ${who.join(' · ')}`}
        </Typography>

        {c.files.length > 0 ? (
          <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
            {files.map((f) => (
              <Tooltip key={f} title={f}>
                <Chip size="small" variant="outlined" label={fileLabel(f)} component={RouterLink} to={`/workspace?file=${encodeURIComponent(f)}`} clickable />
              </Tooltip>
            ))}
            {c.files.length > FILES_SHOWN && (
              <Link component="button" variant="body2" onClick={() => setAllFiles((v) => !v)}>
                {allFiles ? 'show less' : `+ ${c.files.length - FILES_SHOWN} more`}
              </Link>
            )}
          </Stack>
        ) : null}

        <Stack direction="row" spacing={2} sx={{ mt: 1, alignItems: 'center' }}>
          {c.restoreHash && !c.current && (
            <Button size="small" startIcon={<HistoryOutlined />} onClick={() => onRestore(c)}>
              Go back to this state
            </Button>
          )}
          <Link component="button" variant="caption" color="text.secondary" onClick={() => setDetails((v) => !v)}>
            {details ? 'Hide technical details' : 'Technical details'}
          </Link>
        </Stack>
        <Collapse in={details} unmountOnExit>
          <Box sx={{ mt: 1, pl: 1.5, borderLeft: 2, borderColor: 'divider' }}>
            {c.commits.map((k) => (
              <Stack key={k.hash} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="caption" sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
                  {k.shortHash}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {k.subject}
                </Typography>
                <Button size="small" onClick={() => onDiff(k.hash)}>
                  Diff
                </Button>
              </Stack>
            ))}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
}

/** Workspace history for business users: tasks with title, status and files instead of Git commits. */
export function WorkspaceHistory({ changes }: { changes: WorkspaceChange[] }) {
  const [target, setTarget] = useState<WorkspaceChange>();
  const [diff, setDiff] = useState<string>();
  if (changes.length === 0) return <Typography variant="body2" color="text.secondary">Nothing has happened here yet.</Typography>;
  return (
    <>
      <Box>
        {changes.map((c) => (
          <Entry key={c.id} c={c} onRestore={setTarget} onDiff={setDiff} />
        ))}
      </Box>
      <RestoreConfirm target={target?.restoreHash ? { hash: target.restoreHash, date: target.at, label: target.title } : undefined} onClose={() => setTarget(undefined)} />
      <DiffDialog hash={diff} onClose={() => setDiff(undefined)} />
    </>
  );
}
