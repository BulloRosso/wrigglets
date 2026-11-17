import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { api, type LiquidApp } from '../api';

/*
 * App registry (ADR-0050): small UIs built on the generated app SDK, each with an owner, the actions and classes it may
 * use, and an expiry date. Registration runs a static check; activation gives the app its OIDC client; the app host
 * serves it on its own origin. Expired or disabled apps cannot sign anyone in.
 */

const STATUS: Record<LiquidApp['status'], 'success' | 'default' | 'error' | 'warning' | 'info'> = { active: 'success', registered: 'info', rejected: 'error', disabled: 'default', expired: 'warning' };
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;

function daysLeft(iso: string) {
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

/** Who may use the app (role Agent.User on its OIDC client); administrators always may. */
function Access({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['liquid-app-access', appId], queryFn: () => api.liquidAppAccess(appId) });
  const set = useMutation({ mutationFn: (x: { userId: string; allowed: boolean }) => api.setLiquidAppAccess(appId, x.userId, x.allowed), onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-app-access', appId] }) });
  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
        Who may use it
      </Typography>
      <ErrorAlert error={q.error ?? set.error} title="Access" />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {(q.data ?? []).map((u) => (
          <Chip
            key={u.id}
            size="small"
            variant={u.allowed ? 'filled' : 'outlined'}
            color={u.allowed ? 'primary' : 'default'}
            label={`${u.name}${u.via && u.via !== 'app' ? ` (${u.via})` : ''}`}
            title={u.via && u.via !== 'app' ? `${u.email}: access through ${u.via === 'admin' ? 'Platform.Admin' : 'Agent.User on all agents'}` : u.email}
            disabled={(u.via !== null && u.via !== 'app') || set.isPending}
            onClick={() => set.mutate({ userId: u.id, allowed: !u.allowed })}
          />
        ))}
      </Stack>
    </Box>
  );
}

function AppCard({ a }: { a: LiquidApp }) {
  const qc = useQueryClient();
  const act = useMutation({ mutationFn: (x: 'activate' | 'disable' | 'recheck' | 'extend') => api.liquidAppAction(a.id, x, x === 'extend' ? { days: 180 } : {}), onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-apps'] }) });
  const left = daysLeft(a.expiresAt);
  return (
    <Card variant="outlined">
      <CardHeader
        title={a.status === 'active' ? <Link href={a.url} target="_blank" rel="noreferrer">{a.name}</Link> : a.name}
        subheader={<>owner {a.owner} · version {a.version} · registered <RelativeTime iso={a.registeredAt} /> by {a.registeredBy}</>}
        action={<Stack direction="row" spacing={1}><Chip size="small" color={STATUS[a.status]} label={a.status} /><Chip size="small" variant="outlined" color={left <= 14 ? 'warning' : 'default'} label={left > 0 ? `expires in ${left} days` : `expired ${a.expiresAt.slice(0, 10)}`} /></Stack>}
      />
      <CardContent>
        <Stack spacing={1.5}>
          {a.description && <Typography variant="body2">{a.description}</Typography>}
          <Typography variant="body2">
            <b>Actions:</b> {a.actions.length ? a.actions.join(', ') : '—'} · <b>Reads:</b> {a.reads.length ? a.reads.join(', ') : '—'}
            {a.source && (
              <>
                {' '}· <Link href={a.source} target="_blank" rel="noreferrer">source</Link>
              </>
            )}
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {a.checks.map((c) => (
              <Chip key={c.name} size="small" variant="outlined" color={c.ok ? 'success' : 'error'} label={`${c.ok ? '✓' : '✗'} ${c.name}`} />
            ))}
            <Typography variant="caption" sx={{ alignSelf: 'center' }}>
              checked against ontology {a.ontologyVersion}
            </Typography>
          </Stack>
          {a.checks.some((c) => !c.ok) && (
            <Box component="ul" sx={{ m: 0, pl: 3, fontSize: 13 }}>
              {a.checks.flatMap((c) => (c.errors ?? []).map((e) => <li key={`${c.name}${e}`}>{e}</li>))}
            </Box>
          )}
          {a.status === 'active' && <Access appId={a.id} />}
          {a.statusNote && <Alert severity="info">{a.statusNote}</Alert>}
          <ErrorAlert error={act.error} title="Not possible" />
          <Stack direction="row" spacing={1}>
            {a.status !== 'active' && a.status !== 'rejected' && (
              <Button variant="contained" disabled={act.isPending || left <= 0} onClick={() => act.mutate('activate')}>
                Activate
              </Button>
            )}
            {a.status === 'active' && (
              <Button variant="outlined" href={a.url} target="_blank" rel="noreferrer">
                Open
              </Button>
            )}
            <Button disabled={act.isPending} onClick={() => act.mutate('recheck')}>
              Check again
            </Button>
            <Button disabled={act.isPending} onClick={() => act.mutate('extend')}>
              Extend 180 days
            </Button>
            {a.status === 'active' && (
              <Button color="error" disabled={act.isPending} onClick={() => act.mutate('disable')}>
                Disable
              </Button>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

/** Register from a local folder (the browser reads the files; node_modules is skipped). */
function Register() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ id: '', name: '', owner: '', description: '', actions: '', reads: '', source: '' });
  const [files, setFiles] = useState<Record<string, string>>({});
  const reg = useMutation({
    mutationFn: () =>
      api.registerLiquidApp({
        ...form,
        source: form.source || undefined,
        actions: form.actions.split(/[\s,]+/).filter(Boolean),
        reads: form.reads.split(/[\s,]+/).filter(Boolean),
        files,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-apps'] }),
  });
  const pick = async (list: FileList | null) => {
    const out: Record<string, string> = {};
    for (const f of Array.from(list ?? [])) {
      const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/');
      if (!rel || SKIP.test(rel)) continue;
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      out[rel] = btoa(bin);
    }
    setFiles(out);
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Card variant="outlined">
      <CardHeader title="Register an app" subheader="Built on the app SDK (download it below), with its built dist/ folder. The check runs at once; activation is a separate step." />
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField size="small" label="Id" value={form.id} onChange={set('id')} helperText="lowercase, e.g. supplier-due-diligence" />
            <TextField size="small" label="Name" value={form.name} onChange={set('name')} />
            <TextField size="small" label="Owner (e-mail)" value={form.owner} onChange={set('owner')} />
          </Stack>
          <TextField size="small" label="Description" value={form.description} onChange={set('description')} />
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField size="small" fullWidth label="Actions it may run" value={form.actions} onChange={set('actions')} helperText="comma separated action names" />
            <TextField size="small" fullWidth label="Classes it may read" value={form.reads} onChange={set('reads')} helperText="e.g. Supplier" />
            <TextField size="small" fullWidth label="Source (URL, optional)" value={form.source} onChange={set('source')} />
          </Stack>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <input ref={input} type="file" hidden multiple {...({ webkitdirectory: '' } as object)} onChange={(e) => void pick(e.target.files)} />
            <Button variant="outlined" onClick={() => input.current?.click()}>
              Choose app folder
            </Button>
            <Typography variant="body2">{Object.keys(files).length ? `${Object.keys(files).length} files` : 'no folder chosen'}</Typography>
            <Button href="/api/liquid/ontology/sdk?kind=app" target="_blank">
              Download the app SDK
            </Button>
          </Stack>
          <ErrorAlert error={reg.error} title="Registration refused" />
          {reg.data && <Alert severity={reg.data.status === 'rejected' ? 'error' : 'success'}>{reg.data.status === 'rejected' ? 'The app did not pass the check (see its card).' : 'Registered and checked: activate it on its card.'}</Alert>}
          <Box>
            <Button variant="contained" disabled={reg.isPending || !form.id || !form.name || !form.owner || !Object.keys(files).length} onClick={() => reg.mutate()}>
              Register and check
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

export function LiquidAppsPage() {
  const q = useQuery({ queryKey: ['liquid-apps'], queryFn: api.liquidApps, refetchInterval: 10_000 });
  return (
    <>
      <PageHeader overline="Liquid enterprise" title="Apps" subtitle="Small UIs on the generated SDK: registered with an owner, the actions they may use and an expiry date; served by the app host on their own origin." />
      <ErrorAlert error={q.error} title="Could not load the apps" />
      {q.isLoading ? (
        <Loading />
      ) : (
        <Stack spacing={2}>
          {(q.data ?? []).length === 0 && <EmptyState title="No apps registered yet" text="Register one below, e.g. the supplier due-diligence sample (apps/liquid-apps/supplier-due-diligence)." />}
          {(q.data ?? []).map((a) => (
            <AppCard key={a.id} a={a} />
          ))}
          <Register />
        </Stack>
      )}
    </>
  );
}
