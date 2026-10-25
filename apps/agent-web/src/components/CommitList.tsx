import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import type { CommitInfo } from '@cw/shared';
import { ErrorAlert, Loading, RelativeTime } from '@cw/ui';
import { api } from '../api';

/** Diff viewer for a single commit (`git show`), coloured line by line. */
export function DiffDialog({ hash, onClose }: { hash?: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['diff', hash], queryFn: () => api.commitDiff(hash!), enabled: !!hash });
  return (
    <Dialog open={!!hash} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle sx={{ pr: 6 }}>
        Commit {hash?.slice(0, 10)}
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }} aria-label="Close">
          <CloseOutlined />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {q.isLoading && <Loading />}
        <ErrorAlert error={q.error} />
        {q.data && (
          <Box component="pre" sx={{ m: 0, p: 2, fontSize: 12.5, fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'auto' }}>
            {q.data.split('\n').map((line, i) => (
              <Box
                key={i}
                component="span"
                sx={{
                  display: 'block',
                  color: line.startsWith('+') && !line.startsWith('+++') ? 'success.main' : line.startsWith('-') && !line.startsWith('---') ? 'error.main' : line.startsWith('@@') ? 'info.main' : 'text.primary',
                  bgcolor: line.startsWith('diff --git') ? 'action.hover' : undefined,
                }}
              >
                {line || ' '}
              </Box>
            ))}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Commits with their trailers: who requested, who approved, which task (spec §11.2). */
export function CommitList({ commits, dense }: { commits: CommitInfo[]; dense?: boolean }) {
  const [diff, setDiff] = useState<string>();
  if (commits.length === 0) return <Typography variant="body2" color="text.secondary">No commits.</Typography>;
  return (
    <>
      <List dense={dense} disablePadding>
        {commits.map((c) => {
          const t = (k: string) => c.trailers[k]?.filter(Boolean) ?? [];
          const taskId = t('Task-Id')[0];
          return (
            <ListItem key={c.hash} divider alignItems="flex-start" secondaryAction={<Button size="small" onClick={() => setDiff(c.hash)}>Diff</Button>} sx={{ pr: 10 }}>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                    <Typography variant="body2" component="span" sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
                      {c.shortHash}
                    </Typography>
                    <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
                      {c.subject}
                    </Typography>
                  </Stack>
                }
                secondary={
                  <Stack component="span" direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}>
                    <span>
                      <RelativeTime iso={c.date} />
                    </span>
                    {t('Requested-By').map((p) => (
                      <Chip key={`r-${p}`} size="small" variant="outlined" label={`requested by ${p}`} component="span" />
                    ))}
                    {t('Approved-By').map((p) => (
                      <Chip key={`a-${p}`} size="small" color="success" variant="outlined" label={`approved by ${p}`} component="span" />
                    ))}
                    {c.author.email !== c.committer.email && <Chip size="small" variant="outlined" label={`author ${c.author.email}`} component="span" />}
                    {taskId && (
                      <Link component={RouterLink} to={`/tasks/${encodeURIComponent(taskId)}`} variant="caption">
                        {taskId}
                      </Link>
                    )}
                    {!dense && c.files && c.files.length > 0 && (
                      <Typography component="span" variant="caption" color="text.secondary">
                        {c.files.length} file(s): {c.files.slice(0, 4).join(', ')}
                        {c.files.length > 4 ? ' …' : ''}
                      </Typography>
                    )}
                  </Stack>
                }
                slotProps={{ secondary: { component: 'div' } }}
              />
            </ListItem>
          );
        })}
      </List>
      <DiffDialog hash={diff} onClose={() => setDiff(undefined)} />
    </>
  );
}
