import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import PersonAddOutlined from '@mui/icons-material/PersonAddOutlined';
import MoreVertOutlined from '@mui/icons-material/MoreVertOutlined';
import { ALL_AGENT_ROLES, PLATFORM_ROLES, type UserDto } from '@cw/shared';
import { ConfirmDialog, ErrorAlert, Loading, PageHeader, RelativeTime } from '@cw/ui';
import { api } from '../api';

function UserDialog({ user, onClose }: { user?: UserDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    email: user?.email ?? '',
    name: user?.name ?? '',
    password: '',
    admin: user?.platformRoles.includes(PLATFORM_ROLES.admin) ?? false,
    allAgents: user?.agentRoles['*'] ?? ([] as string[]),
  });
  const save = useMutation({
    mutationFn: async () => {
      const platformRoles = f.admin ? [PLATFORM_ROLES.admin] : [];
      const agentRoles = { ...(user?.agentRoles ?? {}), '*': f.allAgents };
      if (user) await api.updateUser(user.id, { name: f.name, platformRoles, agentRoles, password: f.password || undefined });
      else await api.createUser({ email: f.email, name: f.name, password: f.password, platformRoles, agentRoles });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  const toggleAll = (r: string, on: boolean) =>
    setF((x) => {
      let roles = on ? [...new Set([...x.allAgents, r])] : x.allAgents.filter((y) => y !== r);
      if (on && r !== 'Agent.User') roles = [...new Set([...roles, 'Agent.User'])];
      if (!on && r === 'Agent.User') roles = [];
      return { ...x, allAgents: roles };
    });
  const valid = f.name.trim() && (user || (f.email.includes('@') && f.password.length >= 8)) && (!f.password || f.password.length >= 8);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{user ? `Edit ${user.name}` : 'New user'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField label="E-mail (sign-in name)" required disabled={!!user} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <TextField label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <TextField
            label={user ? 'New password (leave empty to keep)' : 'Initial password'}
            type="password"
            required={!user}
            value={f.password}
            onChange={(e) => setF({ ...f, password: e.target.value })}
            helperText="At least 8 characters. Changing it signs the user out everywhere."
          />
          <FormControlLabel control={<Switch checked={f.admin} onChange={(e) => setF({ ...f, admin: e.target.checked })} />} label="Platform admin (admin console + all roles on every agent)" />
          <div>
            <Typography variant="subtitle2">Roles on all agents</Typography>
            <Typography variant="caption" color="text.secondary">
              Per-agent access is managed on each agent's Access tab.
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              {ALL_AGENT_ROLES.map((r) => (
                <Chip key={r} label={r} clickable color={f.allAgents.includes(r) ? 'primary' : 'default'} variant={f.allAgents.includes(r) ? 'filled' : 'outlined'} onClick={() => toggleAll(r, !f.allAgents.includes(r))} />
              ))}
            </Stack>
          </div>
          <ErrorAlert error={save.error} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {user ? 'Save' : 'Create user'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RowMenu({ u, onEdit }: { u: UserDto; onEdit: () => void }) {
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const toggle = useMutation({ mutationFn: () => api.updateUser(u.id, { disabled: !u.disabled }), onSuccess: refresh });
  const revoke = useMutation({ mutationFn: () => api.revokeSessions(u.id) });
  const del = useMutation({ mutationFn: () => api.deleteUser(u.id), onSuccess: refresh });
  return (
    <>
      <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)} aria-label={`Actions for ${u.email}`}>
        <MoreVertOutlined />
      </IconButton>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => (setAnchor(null), onEdit())}>Edit</MenuItem>
        <MenuItem onClick={() => (setAnchor(null), toggle.mutate())}>{u.disabled ? 'Enable' : 'Disable'}</MenuItem>
        <MenuItem onClick={() => (setAnchor(null), revoke.mutate())}>Sign out everywhere</MenuItem>
        <MenuItem sx={{ color: 'error.main' }} onClick={() => (setAnchor(null), setDeleting(true))}>
          Delete
        </MenuItem>
      </Menu>
      <ErrorAlert error={toggle.error ?? revoke.error} />
      <ConfirmDialog open={deleting} title={`Delete ${u.email}?`} text="The account and all its role assignments are removed. Audit records keep the e-mail address." confirmLabel="Delete" confirmColor="error" busy={del.isPending} error={del.error} onClose={() => setDeleting(false)} onConfirm={() => del.mutate()} />
    </>
  );
}

export function UsersPage() {
  const q = useQuery({ queryKey: ['users'], queryFn: api.users });
  const agents = useQuery({ queryKey: ['agents', 'names'], queryFn: () => api.agents(false) });
  const [editing, setEditing] = useState<UserDto | 'new' | undefined>();
  const name = (id: string) => (id === '*' ? 'all agents' : (agents.data?.find((a) => a.spec.agentId === id)?.spec.displayName ?? id));

  return (
    <>
      <PageHeader
        title="Users & access"
        subtitle="Accounts of the OAuth server. People sign in there when they open an agent; the roles they get depend on the agent."
        actions={
          <Button variant="contained" startIcon={<PersonAddOutlined />} onClick={() => setEditing('new')}>
            New user
          </Button>
        }
      />
      <ErrorAlert error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : (
        <Card>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>E-mail</TableCell>
                  <TableCell>Access</TableCell>
                  <TableCell>Last sign-in</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {q.data?.map((u) => (
                  <TableRow key={u.id} hover>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>
                      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                        {u.platformRoles.map((r) => (
                          <Chip key={r} size="small" color="secondary" label={r} />
                        ))}
                        {Object.entries(u.agentRoles).map(([agent, roles]) => (
                          <Chip key={agent} size="small" variant="outlined" label={`${name(agent)}: ${roles.map((r) => r.replace('Agent.', '')).join(', ')}`} />
                        ))}
                        {!u.platformRoles.length && !Object.keys(u.agentRoles).length && (
                          <Typography variant="caption" color="text.secondary">
                            no access
                          </Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <RelativeTime iso={u.lastLoginAt} />
                    </TableCell>
                    <TableCell>{u.disabled ? <Chip size="small" label="disabled" /> : <Chip size="small" color="success" variant="outlined" label="active" />}</TableCell>
                    <TableCell align="right">
                      <RowMenu u={u} onEdit={() => setEditing(u)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
      {editing && <UserDialog user={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />}
    </>
  );
}
