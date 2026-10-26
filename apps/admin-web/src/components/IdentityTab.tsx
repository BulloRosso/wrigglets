import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { AgentEntra, AgentSummary } from '@cw/shared';
import { ConfirmDialog, ErrorAlert, Loading } from '@cw/ui';
import { api } from '../api';

/*
 * Optional Microsoft Entra identity of an agent (ADR-0032): the agent is the confidential client of the
 * On-Behalf-Of exchange, so MCP servers receive a token that carries the agent's and the user's identity
 * (Foundry-compatible). The credential is only a Key Vault reference; the control plane hands the resolved
 * value to the agent container — agents never access Key Vault.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Kind = AgentEntra['credential']['kind'];

const empty = { enabled: true, tenantId: '', clientId: '', kind: 'secret' as Kind, secretRef: '', allowAgentOnly: false };

export function IdentityTab({ a }: { a: AgentSummary }) {
  const qc = useQueryClient();
  const agentId = a.spec.agentId;
  const q = useQuery({ queryKey: ['agent-entra', agentId], queryFn: () => api.agentEntra(agentId) });
  const tenant = useQuery({ queryKey: ['entra'], queryFn: api.entraAvailable, staleTime: 60_000 });
  const [f, setF] = useState(empty);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    const e = q.data?.entra;
    if (e) setF({ enabled: e.enabled, tenantId: e.tenantId ?? '', clientId: e.clientId, kind: e.credential.kind, secretRef: e.credential.secretRef ?? '', allowAgentOnly: e.allowAgentOnly });
  }, [q.data]);

  const done = () => {
    void qc.invalidateQueries({ queryKey: ['agent-entra', agentId] });
    void qc.invalidateQueries({ queryKey: ['agent', agentId] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.setAgentEntra(agentId, {
        enabled: f.enabled,
        tenantId: f.tenantId || undefined,
        clientId: f.clientId.trim(),
        credential: { kind: f.kind, secretRef: f.kind === 'federated' ? undefined : f.secretRef.trim() },
        allowAgentOnly: f.allowAgentOnly,
      }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api.setAgentEntra(agentId, null),
    onSuccess: () => (setRemoving(false), setF(empty), done()),
  });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  const current = q.data.entra;
  if (!q.data.available && !current) {
    return (
      <Alert severity="info">
        Entra On-Behalf-Of is an optional capability and is not configured on this platform. Set <code>ENTRA_TENANT_ID</code> on the control plane (and use Microsoft
        Entra ID as the sign-in provider) to let agents call MCP servers with a token that carries the agent and the user identity.
      </Alert>
    );
  }
  const needsRef = f.kind !== 'federated';
  const valid = GUID.test(f.clientId.trim()) && (!f.tenantId || GUID.test(f.tenantId)) && (!needsRef || /^[0-9a-zA-Z-]{1,127}$/.test(f.secretRef.trim())) && (!!f.tenantId || !!tenant.data?.tenantId);

  return (
    <Stack spacing={2}>
      <Card>
        <CardHeader
          title="Microsoft Entra identity"
          subheader="Lets this agent call MCP servers on behalf of the signed-in user (On-Behalf-Of)."
          action={<Chip size="small" color={current?.enabled ? 'success' : 'default'} label={current?.enabled ? 'enabled' : 'off'} />}
        />
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" sx={{ alignItems: 'center' }}>
              <Switch checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
              <Typography variant="body2">Use Entra OBO for this agent</Typography>
            </Stack>
            <TextField
              label="Tenant ID"
              value={f.tenantId}
              onChange={(e) => setF({ ...f, tenantId: e.target.value })}
              placeholder={tenant.data?.tenantId ?? 'GUID'}
              helperText={tenant.data?.tenantId ? 'Leave empty to use the platform default.' : 'No platform default configured: required.'}
              error={!!f.tenantId && !GUID.test(f.tenantId)}
            />
            <TextField
              label="Application (client) ID of the agent"
              value={f.clientId}
              onChange={(e) => setF({ ...f, clientId: e.target.value })}
              helperText="The agent's app registration / agent identity. It must expose the scope api://<client id>/access_as_user and be allowed to call the MCP servers' APIs."
              error={!!f.clientId && !GUID.test(f.clientId.trim())}
            />
            <TextField select label="Credential" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
              <MenuItem value="secret">Client secret (Key Vault)</MenuItem>
              <MenuItem value="cert">Certificate with private key, PEM (Key Vault)</MenuItem>
              <MenuItem value="federated">Federated credential (workload identity)</MenuItem>
            </TextField>
            {needsRef && (
              <TextField
                label="Key Vault secret name"
                value={f.secretRef}
                onChange={(e) => setF({ ...f, secretRef: e.target.value })}
                helperText="Store the value under Safety & tools → Secrets. The control plane reads it and passes it to the agent; the agent never accesses Key Vault."
              />
            )}
            <Stack direction="row" sx={{ alignItems: 'flex-start' }}>
              <Switch checked={f.allowAgentOnly} onChange={(e) => setF({ ...f, allowAgentOnly: e.target.checked })} />
              <div>
                <Typography variant="body2">Allow the agent's own token for tasks without a signed-in user</Typography>
                <Typography variant="caption" color="text.secondary">
                  Scheduled and agent-to-agent tasks have no user to act for. With this on (and "Agent-only" chosen on the upstream), they use the agent's client-credentials
                  token, which carries no user identity. Tasks started by a user never fall back to it.
                </Typography>
              </div>
            </Stack>
            <Alert severity="warning" sx={{ py: 0 }}>
              Saving re-creates the agent's container (the workspace is kept).
            </Alert>
            <ErrorAlert error={save.error} />
            {save.isSuccess && <Alert severity="success">Saved.</Alert>}
            <Stack direction="row" spacing={1}>
              <Button variant="contained" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
              {current && (
                <Button color="error" onClick={() => setRemoving(true)}>
                  Remove Entra identity
                </Button>
              )}
            </Stack>
          </Stack>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={removing}
        title="Remove Entra identity?"
        text="MCP servers that use Entra OBO will refuse calls from this agent. The container is re-created."
        confirmLabel="Remove"
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
        onClose={() => setRemoving(false)}
      />
    </Stack>
  );
}
