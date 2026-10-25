import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined';
import { Logo } from '@cw/ui';

interface Details {
  uid: string;
  prompt: string;
  client: { clientId?: string; name?: string };
  loginHint?: string;
}

/** Sign-in page of the OAuth server (interaction prompt "login"). */
export function LoginPage() {
  const uid = window.location.pathname.split('/')[2] ?? '';
  const [details, setDetails] = useState<Details>();
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/interaction/${uid}/details`, { credentials: 'same-origin' })
      .then(async (r) => {
        const body = (await r.json()) as Details & { error?: string };
        if (!r.ok) throw new Error(body.error ?? 'This sign-in request is no longer valid.');
        setDetails(body);
        if (body.loginHint) setEmail(body.loginHint);
      })
      .catch((e: Error) => setError(e.message));
  }, [uid]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch(`/interaction/${uid}/login`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = (await r.json()) as { redirectTo?: string; error?: string };
      if (!r.ok || !body.redirectTo) throw new Error(body.error ?? 'Sign-in failed.');
      window.location.assign(body.redirectTo);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function cancel() {
    const r = await fetch(`/interaction/${uid}/abort`, { method: 'POST', credentials: 'same-origin' });
    const body = (await r.json().catch(() => ({}))) as { redirectTo?: string };
    if (body.redirectTo) window.location.assign(body.redirectTo);
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'background.default' }}>
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 3, color: 'primary.main' }}>
            <Logo />
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Coworking Agents
            </Typography>
          </Stack>
          <Typography variant="h5" component="h1" gutterBottom>
            Sign in
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {details ? (
              <>
                to continue to <strong>{details.client.name ?? details.client.clientId}</strong>
              </>
            ) : (
              'Loading…'
            )}
          </Typography>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <Stack component="form" spacing={2.5} onSubmit={submit}>
            <TextField label="E-mail" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} disabled={!details || busy} size="medium" />
            <TextField
              label="Password"
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={!details || busy}
              size="medium"
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShow((s) => !s)} edge="end" aria-label={show ? 'Hide password' : 'Show password'}>
                        {show ? <VisibilityOffOutlined /> : <VisibilityOutlined />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Button type="submit" variant="contained" size="large" disabled={!details || busy || !email || !password}>
              {busy ? <CircularProgress size={22} color="inherit" /> : 'Sign in'}
            </Button>
          </Stack>
          {details && (
            <Typography variant="body2" sx={{ mt: 3, textAlign: 'center' }}>
              <Link component="button" onClick={cancel}>
                Cancel
              </Link>
            </Typography>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
