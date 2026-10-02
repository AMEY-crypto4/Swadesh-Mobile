import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth, type Role } from './lib/auth';
import { LiveProvider } from './lib/live';
import { AdminLayout } from './components/Layout';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Wallboard } from './pages/admin/Wallboard';
import { Agents } from './pages/admin/Agents';
import { Queues } from './pages/admin/Queues';
import { Campaigns } from './pages/admin/Campaigns';
import { CampaignDetail } from './pages/admin/CampaignDetail';
import { CallLog } from './pages/admin/CallLog';
import { Reports } from './pages/admin/Reports';
import { Developer } from './pages/admin/Developer';
import { Privacy } from './pages/admin/Privacy';
import { Audit } from './pages/admin/Audit';
import { AgentWorkspace } from './pages/agent/Workspace';

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Restoring session" />;
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to={user.role === 'agent' ? '/agent' : '/'} replace />;
  return <LiveProvider>{children}</LiveProvider>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/agent" element={<Guard roles={['agent']}><AgentWorkspace /></Guard>} />
      <Route element={<Guard roles={['admin', 'supervisor']}><AdminLayout /></Guard>}>
        <Route index element={<Wallboard />} />
        <Route path="agents" element={<Agents />} />
        <Route path="queues" element={<Queues />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="campaigns/:id" element={<CampaignDetail />} />
        <Route path="calls" element={<CallLog />} />
        <Route path="reports" element={<Reports />} />
        <Route path="developer" element={<Guard roles={['admin']}><Developer /></Guard>} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="audit" element={<Guard roles={['admin']}><Audit /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
