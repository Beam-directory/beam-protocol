import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { AdminAuthProvider, useAdminAuth } from './lib/admin-auth'
import AgentProfilePage from './pages/AgentProfilePage'
import AgentsPage from './pages/AgentsPage'
import AlertsPage from './pages/AlertsPage'
import AuthCallbackPage from './pages/AuthCallbackPage'
import AuditPage from './pages/AuditPage'
import BetaRequestsPage from './pages/BetaRequestsPage'
import DeadLetterPage from './pages/DeadLetterPage'
import ErrorsPage from './pages/ErrorsPage'
import FederationPage from './pages/FederationPage'
import FunnelPage from './pages/FunnelPage'
import IntentsPage from './pages/IntentsPage'
import LoginPage from './pages/LoginPage'
import OperatorInboxPage from './pages/OperatorInboxPage'
import OverviewPage from './pages/OverviewPage'
import RegisterPage from './pages/RegisterPage'
import SettingsPage from './pages/SettingsPage'
import TraceDetailPage from './pages/TraceDetailPage'
import WorkspacesPage from './pages/WorkspacesPage'

function RequireAdminSession({ children }: { children: JSX.Element }) {
  const { session, loading } = useAdminAuth()

  if (loading) {
    return <div className="min-h-screen bg-slate-50 dark:bg-slate-950" />
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return children
}

export default function App() {
  return (
    <AdminAuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route
            path="/"
            element={(
              <RequireAdminSession>
                <Layout />
              </RequireAdminSession>
            )}
          >
            <Route index element={<OverviewPage />} />
            <Route path="intents" element={<IntentsPage />} />
            <Route path="intents/:nonce" element={<TraceDetailPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="agents/:beamId" element={<AgentProfilePage />} />
            <Route path="federation" element={<FederationPage />} />
            <Route path="funnel" element={<FunnelPage />} />
            <Route path="errors" element={<ErrorsPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="inbox" element={<OperatorInboxPage />} />
            <Route path="beta-requests" element={<BetaRequestsPage />} />
            <Route path="workspaces" element={<WorkspacesPage />} />
            <Route path="dead-letter" element={<DeadLetterPage />} />
            <Route path="register" element={<RegisterPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AdminAuthProvider>
  )
}
