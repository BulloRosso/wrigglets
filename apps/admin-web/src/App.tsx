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
import SensorsOutlined from '@mui/icons-material/SensorsOutlined';
import ExtensionOutlined from '@mui/icons-material/ExtensionOutlined';
import WaterDropOutlined from '@mui/icons-material/WaterDropOutlined';
import HubOutlined from '@mui/icons-material/HubOutlined';
import GavelOutlined from '@mui/icons-material/GavelOutlined';
import { useQuery } from '@tanstack/react-query';
import { AppShell, ErrorAlert, Loading } from '@cw/ui';
import { api, useMe } from './api';
import { GlobalKillSwitch } from './components/KillSwitch';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { AuditPage } from './pages/AuditPage';
import { DashboardPage } from './pages/DashboardPage';
import { SafetyPage } from './pages/SafetyPage';
import { MailPage } from './pages/MailPage';
import { UsersPage } from './pages/UsersPage';
import { SignalsPage } from './pages/SignalsPage';
import { ExtensionsPage } from './pages/ExtensionsPage';
import { LiquidOverviewPage } from './pages/LiquidOverviewPage';
import { LiquidOntologyPage } from './pages/LiquidOntologyPage';
import { LiquidPoliciesPage } from './pages/LiquidPoliciesPage';
import { LiquidProcessesPage } from './pages/LiquidProcessesPage';
import { LiquidProposalsPage } from './pages/LiquidProposalsPage';
import { LiquidPlaybooksPage } from './pages/LiquidPlaybooksPage';
import { LiquidEventsPage } from './pages/LiquidEventsPage';
import { LiquidApprovalsPage } from './pages/LiquidApprovalsPage';
import { LiquidAppsPage } from './pages/LiquidAppsPage';
import { LiquidTutorialPage } from './pages/LiquidTutorialPage';
import SchoolOutlined from '@mui/icons-material/SchoolOutlined';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import InboxOutlined from '@mui/icons-material/InboxOutlined';
import ReceiptLongOutlined from '@mui/icons-material/ReceiptLongOutlined';
import RateReviewOutlined from '@mui/icons-material/RateReviewOutlined';
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import { WikiPage } from './pages/WikiPage';
import { RoleViewSwitch, forView, useRoleView } from './components/Sections';

export function App() {
  const me = useMe();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Signals is optional (ADR-0037): shown only when the control plane has the module configured
  const signals = useQuery({ queryKey: ['signals-available'], queryFn: api.signalsAvailable, enabled: !!me.data, staleTime: 60_000 });
  // Installed extensions (ADR-0039) add their pages under their own nav group while they are available
  const extensions = useQuery({ queryKey: ['extensions'], queryFn: api.extensions, enabled: !!me.data, staleTime: 15_000 });
  const liquid = extensions.data?.find((e) => e.id === 'liquid');
  const LIQUID_ICONS: Record<string, React.ReactNode> = {
    '/liquid': <WaterDropOutlined />,
    '/liquid/tutorial': <SchoolOutlined />,
    '/liquid/ontology': <HubOutlined />,
    '/liquid/policies': <GavelOutlined />,
    '/liquid/processes': <AccountTreeOutlined />,
    '/liquid/proposals': <RateReviewOutlined />,
    '/liquid/playbooks': <ShieldOutlined />,
    '/liquid/events': <ReceiptLongOutlined />,
    '/liquid/approvals': <InboxOutlined />,
    '/liquid/apps': <AppsOutlined />,
  };
  const { view } = useRoleView();
  // navigation by task and role (UI review): IT Engineer = platform, security, configuration; Business Engineer =
  // business model, processes, approvals, knowledge. "All" shows everything. Order and groups stay the same in every view.
  type Item = { label: string; icon: React.ReactNode; to: string; group: string; roles?: Array<'it' | 'business'> };
  const LIQUID_ROLES: Record<string, Array<'it' | 'business'> | undefined> = { '/liquid/ontology': ['business'], '/liquid/processes': ['business'], '/liquid/policies': ['it'], '/liquid/playbooks': ['it'], '/liquid/events': ['it'] };
  const items: Item[] = [
    { label: 'Dashboard', icon: <DashboardOutlined />, to: '/dashboard', group: 'Overview' },
    { label: 'Agents', icon: <SmartToyOutlined />, to: '/agents', group: 'Agents and people' },
    { label: 'Users & access', icon: <GroupOutlined />, to: '/users', group: 'Agents and people', roles: ['it'] },
    { label: 'Company wiki', icon: <MenuBookOutlined />, to: '/wiki', group: 'Knowledge', roles: ['business'] },
    ...(signals.data?.available ? [{ label: 'Signals', icon: <SensorsOutlined />, to: '/signals', group: 'Knowledge', roles: ['business'] } as Item] : []),
    { label: 'Safety & tools', icon: <ShieldOutlined />, to: '/safety', group: 'Security and operations', roles: ['it'] },
    { label: 'Audit log', icon: <HistoryEduOutlined />, to: '/audit', group: 'Security and operations', roles: ['it'] },
    { label: 'Mail outbox', icon: <MailOutlined />, to: '/mail', group: 'Security and operations', roles: ['it'] },
    { label: 'Extensions', icon: <ExtensionOutlined />, to: '/extensions', group: 'Security and operations', roles: ['it'] },
    ...(liquid?.available ? liquid.uiRoutes.map((r) => ({ label: r.label, icon: LIQUID_ICONS[r.path] ?? <WaterDropOutlined />, to: r.path, group: 'Liquid enterprise', roles: LIQUID_ROLES[r.path] })) : []),
  ];
  const nav = items.filter((n) => forView(view, n.roles)).map((n) => ({ ...n, selected: pathname === n.to || (n.to !== '/liquid' && pathname.startsWith(`${n.to}/`)), onClick: () => navigate(n.to) }));

  return (
    <AppShell
      product="Coworking Agents"
      context="Admin console · control plane"
      nav={nav}
      user={me.data?.user}
      actions={
        me.data ? (
          <>
            <RoleViewSwitch />
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
          <Route path="/signals" element={<SignalsPage />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/extensions" element={<ExtensionsPage />} />
          <Route path="/liquid" element={<LiquidOverviewPage />} />
          <Route path="/liquid/tutorial" element={<LiquidTutorialPage />} />
          <Route path="/liquid/ontology" element={<LiquidOntologyPage />} />
          <Route path="/liquid/policies" element={<LiquidPoliciesPage />} />
          <Route path="/liquid/processes" element={<LiquidProcessesPage />} />
          <Route path="/liquid/proposals" element={<LiquidProposalsPage />} />
          <Route path="/liquid/proposals/:id" element={<LiquidProposalsPage />} />
          <Route path="/liquid/playbooks" element={<LiquidPlaybooksPage />} />
          <Route path="/liquid/events" element={<LiquidEventsPage />} />
          <Route path="/liquid/approvals" element={<LiquidApprovalsPage />} />
          <Route path="/liquid/apps" element={<LiquidAppsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      )}
    </AppShell>
  );
}
