import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { EmptyState, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { api, type LiquidApp } from '../api';
import { ProcessStepper } from '../components/Sections';

/*
 * App registry (ADR-0050): small UIs built on the generated app SDK, each with an owner, the actions and classes it may
 * use, and an expiry date. Registration runs a static check; activation gives the app its OIDC client; the app host
 * serves it on its own origin. Expired or disabled apps cannot sign anyone in.
 */

const STATUS: Record<LiquidApp['status'], 'success' | 'default' | 'error' | 'warning' | 'info'> = {
  active: 'success',
  registered: 'info',
  rejected: 'error',
  disabled: 'default',
  expired: 'warning',
};
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;

function daysLeft(iso: string) {
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

/** Who may use the app (role Agent.User on its OIDC client); administrators always may. */
function Access({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['liquid-app-access', appId],
    queryFn: () => api.liquidAppAccess(appId),
  });
  const set = useMutation({
    mutationFn: (x: { userId: string; allowed: boolean }) => api.setLiquidAppAccess(appId, x.userId, x.allowed),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-app-access', appId] }),
  });
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
  const act = useMutation({
    mutationFn: (x: 'activate' | 'disable' | 'recheck' | 'extend') => api.liquidAppAction(a.id, x, x === 'extend' ? { days: 180 } : {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['liquid-apps'] }),
  });
  const left = daysLeft(a.expiresAt);
  return (
    <Card variant="outlined">
      <CardHeader
        title={
          a.status === 'active' ? (
            <Link href={a.url} target="_blank" rel="noreferrer">
              {a.name}
            </Link>
          ) : (
            a.name
          )
        }
        subheader={
          <>
            owner {a.owner} · version {a.version} · registered <RelativeTime iso={a.registeredAt} /> by {a.registeredBy}
          </>
        }
        action={
          <Stack direction="row" spacing={1}>
            <Chip size="small" color={STATUS[a.status]} label={a.status} />
            <Chip size="small" variant="outlined" color={left <= 14 ? 'warning' : 'default'} label={left > 0 ? `expires in ${left} days` : `expired ${a.expiresAt.slice(0, 10)}`} />
          </Stack>
        }
      />
      <CardContent>
        <Stack spacing={1.5}>
          {a.description && <Typography variant="body2">{a.description}</Typography>}
          <Typography variant="body2">
            <b>Actions:</b> {a.actions.length ? a.actions.join(', ') : '—'} · <b>Reads:</b> {a.reads.length ? a.reads.join(', ') : '—'}
            {a.source && (
              <>
                {' '}
                ·{' '}
                <Link href={a.source} target="_blank" rel="noreferrer">
                  source
                </Link>
              </>
            )}
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
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
function Register({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    id: '',
    name: '',
    owner: '',
    description: '',
    actions: '',
    reads: '',
    source: '',
  });
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
  // registration is a sequence: describe, permit, upload, check (UI review LIQ-10)
  const [step, setStep] = useState(0);
  const STEPS = ['Describe', 'Permissions', 'Upload', 'Check'];
  const can = [!!form.id && !!form.name && !!form.owner, true, Object.keys(files).length > 0];
  const close = () => {
    setStep(0);
    reg.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="md">
      <DialogTitle>Register an app</DialogTitle>
      <DialogContent>
        <ProcessStepper steps={STEPS} active={step} failed={reg.data?.status === 'rejected' ? 3 : undefined} />
        {step === 0 && (
          <Stack spacing={1.5}>
            <TextField size="small" label="Id" value={form.id} onChange={set('id')} helperText="lowercase, e.g. supplier-due-diligence" />
            <TextField size="small" label="Name" value={form.name} onChange={set('name')} />
            <TextField size="small" label="Owner (e-mail)" value={form.owner} onChange={set('owner')} helperText="responsible for the app; gets the expiry reminder" />
            <TextField size="small" label="Description" value={form.description} onChange={set('description')} />
            <TextField size="small" label="Source (URL, optional)" value={form.source} onChange={set('source')} />
          </Stack>
        )}
        {step === 1 && (
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              The app may only run these actions and read these classes; the check compares them with the code.
            </Typography>
            <TextField size="small" fullWidth label="Actions it may run" value={form.actions} onChange={set('actions')} helperText="comma separated action names" />
            <TextField size="small" fullWidth label="Classes it may read" value={form.reads} onChange={set('reads')} helperText="e.g. Supplier" />
          </Stack>
        )}
        {step === 2 && (
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              Choose the app folder with its built <code>dist/</code> folder; <code>node_modules</code> is skipped. The app is built on the app SDK.
            </Typography>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <input ref={input} type="file" hidden multiple {...({ webkitdirectory: '' } as object)} onChange={(e) => void pick(e.target.files)} />
              <Button variant="outlined" onClick={() => input.current?.click()}>
                Choose app folder
              </Button>
              <Typography variant="body2">{Object.keys(files).length ? `${Object.keys(files).length} files` : 'no folder chosen'}</Typography>
              <Button href="/api/liquid/ontology/sdk?kind=app" target="_blank">
                Download the app SDK
              </Button>
            </Stack>
          </Stack>
        )}
        {step === 3 && (
          <Stack spacing={1.5}>
            <Typography variant="body2">
              <b>{form.name}</b> ({form.id}) · owner {form.owner} · {Object.keys(files).length} files
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Actions: {form.actions || '—'} · Reads: {form.reads || '—'}
            </Typography>
            <ErrorAlert error={reg.error} title="Registration refused" />
            {reg.data && (
              <Alert severity={reg.data.status === 'rejected' ? 'error' : 'success'}>{reg.data.status === 'rejected' ? 'The app did not pass the check (see its card).' : 'Registered and checked: activate it on its card.'}</Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{reg.data ? 'Close' : 'Cancel'}</Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button disabled={step === 0 || reg.isPending || !!reg.data} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        {step < 3 ? (
          <Button variant="contained" disabled={!can[step]} onClick={() => setStep(step + 1)}>
            Next
          </Button>
        ) : (
          <Button variant="contained" disabled={reg.isPending || !!reg.data} onClick={() => reg.mutate()}>
            Register and check
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export function LiquidAppsPage() {
  const q = useQuery({
    queryKey: ['liquid-apps'],
    queryFn: api.liquidApps,
    refetchInterval: 10_000,
  });
  const [registering, setRegistering] = useState(false);
  return (
    <>
      <PageHeader
        overline="Liquid enterprise"
        title="Apps"
        subtitle="Small UIs on the business model, each with an owner, permitted actions and an expiry date"
        actions={
          <Button variant="contained" onClick={() => setRegistering(true)}>
            Register app
          </Button>
        }
      />
      <ErrorAlert error={q.error} title="Could not load the apps" />
      {q.isLoading ? (
        <Loading />
      ) : (
        <Stack spacing={2}>
          {(q.data ?? []).length === 0 && <EmptyState title="No apps registered yet" text="Register one with “Register app”, e.g. the supplier due-diligence sample (apps/liquid-apps/supplier-due-diligence)." />}
          {(q.data ?? []).map((a) => (
            <AppCard key={a.id} a={a} />
          ))}
        </Stack>
      )}
      <Register open={registering} onClose={() => setRegistering(false)} />
    </>
  );
}
