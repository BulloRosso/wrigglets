import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import Button from '@mui/material/Button';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import SmartToyOutlined from '@mui/icons-material/SmartToyOutlined';
import GroupOutlined from '@mui/icons-material/GroupOutlined';
import HistoryEduOutlined from '@mui/icons-material/HistoryEduOutlined';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import ShieldOutlined from '@mui/icons-material/ShieldOutlined';
import MailOutlined from '@mui/icons-material/MailOutlined';
import MenuBookOutlined from '@mui/icons-material/MenuBookOutlined';
import { AppShell, ErrorAlert, Loading } from '@cw/ui';
import { useMe } from './api';
import { GlobalKillSwitch } from './components/KillSwitch';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { AuditPage } from './pages/AuditPage';
import { DashboardPage } from './pages/DashboardPage';
import { SafetyPage } from './pages/SafetyPage';
import { MailPage } from './pages/MailPage';
import { UsersPage } from './pages/UsersPage';
import { WikiPage } from './pages/WikiPage';

export function App() {
  const me = useMe();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const nav = [
    { label: 'Dashboard', icon: <DashboardOutlined />, to: '/dashboard' },
    { label: 'Agents', icon: <SmartToyOutlined />, to: '/agents' },
    { label: 'Safety & tools', icon: <ShieldOutlined />, to: '/safety' },
    { label: 'Company wiki', icon: <MenuBookOutlined />, to: '/wiki' },
    { label: 'Mail outbox', icon: <MailOutlined />, to: '/mail' },
    { label: 'Users & access', icon: <GroupOutlined />, to: '/users' },
    { label: 'Audit log', icon: <HistoryEduOutlined />, to: '/audit' },
  ].map((n) => ({ ...n, selected: pathname === n.to || pathname.startsWith(`${n.to}/`), onClick: () => navigate(n.to) }));

  return (
    <AppShell
      product="Coworking Agents"
      context="Admin console · control plane"
      navTitle="Platform"
      nav={nav}
      user={me.data?.user}
      actions={
        me.data ? (
          <>
            <GlobalKillSwitch />
            <Button size="small" endIcon={<OpenInNewOutlined />} href={me.data.temporalUiUrl} target="_blank" rel="noreferrer" sx={{ display: { xs: 'none', sm: 'inline-flex' } }}>
              Temporal UI
            </Button>
          </>
        ) : undefined
      }
    >
      {me.isLoading && <Loading />}
      <ErrorAlert error={me.error} title="Could not load your profile" />
      {me.data && (
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:id" element={<AgentDetailPage />} />
          <Route path="/safety" element={<SafetyPage />} />
          <Route path="/wiki" element={<WikiPage />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      )}
    </AppShell>
  );
}
