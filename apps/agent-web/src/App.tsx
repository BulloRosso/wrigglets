import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import TaskAltOutlined from '@mui/icons-material/TaskAltOutlined';
import TimelineOutlined from '@mui/icons-material/TimelineOutlined';
import EventRepeatOutlined from '@mui/icons-material/EventRepeatOutlined';
import FolderOutlined from '@mui/icons-material/FolderOutlined';
import ManageSearchOutlined from '@mui/icons-material/ManageSearchOutlined';
import { AgentPortrait, AppShell, ErrorAlert, KillSwitchChip, Loading } from '@cw/ui';
import { agentMood, avatarUrl, useAgentStatus, useMe } from './api';
import { NotificationsButton } from './components/NotificationsButton';
import { AuditPage } from './pages/AuditPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';
import { TimelinePage } from './pages/TimelinePage';
import { WorkspacePage } from './pages/WorkspacePage';

export function App() {
  const me = useMe();
  const status = useAgentStatus();
  const ks = status.data?.killSwitch;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (me.data) document.title = `${me.data.agent.displayName} · AI Colleague`;
  }, [me.data]);

  const nav = [
    { label: 'Tasks', icon: <TaskAltOutlined />, to: '/tasks' },
    { label: 'Activity timeline', icon: <TimelineOutlined />, to: '/timeline' },
    { label: 'Schedules', icon: <EventRepeatOutlined />, to: '/schedules' },
    { label: 'Workspace', icon: <FolderOutlined />, to: '/workspace' },
    { label: 'Audit', icon: <ManageSearchOutlined />, to: '/audit' },
  ].map((n) => ({ ...n, selected: pathname === n.to || pathname.startsWith(`${n.to}/`), onClick: () => navigate(n.to) }));

  return (
    <AppShell
      product={me.data?.agent.displayName ?? 'AI Colleague'}
      context={me.data ? `AI colleague · ${me.data.agent.agentId}` : undefined}
      nav={nav}
      user={me.data?.user}
      avatar={me.data ? <AgentPortrait src={avatarUrl} mood={agentMood(status.data)} name={me.data.agent.displayName} size={44} /> : undefined}
      actions={
        me.data ? (
          <>
            {ks && <KillSwitchChip level={ks.level} reason={ks.reason} />}
            <NotificationsButton />
          </>
        ) : undefined
      }
    >
      {me.isLoading && <Loading />}
      <ErrorAlert error={me.error} title="Could not load your profile" />
      {me.data && (
        <Routes>
          <Route path="/" element={<Navigate to="/tasks" replace />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/workspace/*" element={<WorkspacePage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/tasks" replace />} />
        </Routes>
      )}
    </AppShell>
  );
}
