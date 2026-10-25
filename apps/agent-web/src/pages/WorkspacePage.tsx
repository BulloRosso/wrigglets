import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import FolderOutlined from '@mui/icons-material/FolderOutlined';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import UploadFileOutlined from '@mui/icons-material/UploadFileOutlined';
import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import { EmptyState, ErrorAlert, Loading, PageHeader, formatBytes, formatRelative } from '@cw/ui';
import { api } from '../api';
import { CommitList } from '../components/CommitList';
import { FilePreview, previewLabel } from '../components/FilePreview';

function UploadDialog({ open, dir, onClose }: { open: boolean; dir: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [target, setTarget] = useState(dir || 'uploads');
  const up = useMutation({ mutationFn: () => api.upload(files, target), onSuccess: (r) => navigate(`/tasks/${encodeURIComponent(r.taskId)}`) });
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Upload files</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Uploads become a task of their own so that every change of the workspace is traceable (committed with you as author). Max. 10 files, 50 MB each.
        </Typography>
        <Stack spacing={2}>
          <Button variant="outlined" component="label" startIcon={<UploadFileOutlined />}>
            Choose files
            <input hidden type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 10))} />
          </Button>
          {files.map((f) => (
            <Typography key={f.name} variant="body2">
              {f.name} · {formatBytes(f.size)}
            </Typography>
          ))}
          <TextField label="Target folder" value={target} onChange={(e) => setTarget(e.target.value)} helperText="Relative to the workspace root" />
          <ErrorAlert error={up.error} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!files.length || up.isPending} onClick={() => up.mutate()}>
          Upload
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function WorkspacePage() {
  const [params, setParams] = useSearchParams();
  const file = params.get('file') ?? undefined;
  const dir = params.get('dir') ?? (file ? file.split('/').slice(0, -1).join('/') : '');
  const [tab, setTab] = useState(0);
  const [uploading, setUploading] = useState(false);
  // files change while tasks run: refresh the listing regularly
  const tree = useQuery({ queryKey: ['tree', dir], queryFn: () => api.tree(dir), refetchInterval: 10_000 });
  const history = useQuery({ queryKey: ['history', file ?? dir], queryFn: () => api.commits({ path: file ?? (dir || undefined), limit: 50 }), enabled: tab === 1 || !file });
  const crumbs = dir ? dir.split('/') : [];
  const open = (p: { dir?: string; file?: string }) => setParams(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Record<string, string>);

  return (
    <>
      <PageHeader
        title="Workspace"
        subtitle="The shared data set of the agent (a Git repository). Read-only here; changes happen through tasks and uploads."
        actions={
          <Button variant="contained" startIcon={<UploadFileOutlined />} onClick={() => setUploading(true)}>
            Upload
          </Button>
        }
      />
      <Breadcrumbs sx={{ mb: 2 }}>
        <Link component="button" onClick={() => open({ dir: '' })}>
          workspace
        </Link>
        {crumbs.map((c, i) => (
          <Link key={i} component="button" onClick={() => open({ dir: crumbs.slice(0, i + 1).join('/') })}>
            {c}
          </Link>
        ))}
        {file && <Typography color="text.primary">{file.split('/').pop()}</Typography>}
      </Breadcrumbs>
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 4, lg: 3 }}>
          <Card>
            <List dense sx={{ maxHeight: '75vh', overflow: 'auto' }}>
              {dir && (
                <ListItemButton onClick={() => open({ dir: crumbs.slice(0, -1).join('/') })}>
                  <ListItemIcon>
                    <FolderOutlined />
                  </ListItemIcon>
                  <ListItemText primary=".." />
                </ListItemButton>
              )}
              {tree.isLoading && <Loading />}
              {tree.data?.entries.map((e) => (
                <ListItemButton key={e.path} selected={e.path === file} onClick={() => (e.type === 'dir' ? open({ dir: e.path }) : open({ file: e.path }))}>
                  <ListItemIcon>{e.type === 'dir' ? <FolderOutlined color="primary" /> : <InsertDriveFileOutlined />}</ListItemIcon>
                  <ListItemText primary={e.name} secondary={e.type === 'file' ? `${formatBytes(e.size)} · ${formatRelative(e.modified)}` : undefined} />
                </ListItemButton>
              ))}
            </List>
            <ErrorAlert error={tree.error} />
          </Card>
        </Grid>
        <Grid size={{ xs: 12, md: 8, lg: 9 }}>
          {file ? (
            <Card>
              <CardHeader
                title={file}
                subheader={previewLabel(file)}
                titleTypographyProps={{ sx: { fontFamily: "monospace", fontSize: 15, wordBreak: "break-all" } }}
                action={
                  <Button size="small" startIcon={<DownloadOutlined />} href={api.fileUrl(file, true)}>
                    Download
                  </Button>
                }
                slotProps={{ title: { variant: 'subtitle1', sx: { wordBreak: 'break-all' } } }}
              />
              <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ px: 2 }}>
                <Tab label="Preview" />
                <Tab label="History" />
              </Tabs>
              <CardContent>{tab === 0 ? <FilePreview path={file} /> : history.data ? <CommitList commits={history.data} /> : <Loading />}</CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader title={`History of /${dir}`} subheader="Who requested, who approved, which task" />
              <CardContent sx={{ pt: 0 }}>{history.data ? <CommitList commits={history.data} /> : <Loading />}</CardContent>
            </Card>
          )}
        </Grid>
      </Grid>
      {uploading && <UploadDialog open dir={dir} onClose={() => setUploading(false)} />}
    </>
  );
}
