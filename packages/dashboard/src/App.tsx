import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { LoaderCircle, Radio } from 'lucide-react'
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
import OpenClawFleetPage from './pages/OpenClawFleetPage'
import OverviewPage from './pages/OverviewPage'
import PartnerOpsPage from './pages/PartnerOpsPage'
import RegisterPage from './pages/RegisterPage'
import SettingsPage from './pages/SettingsPage'
import TraceDetailPage from './pages/TraceDetailPage'
import WorkspacesPage from './pages/WorkspacesPage'

function RequireAdminSession({ children }: { children: JSX.Element }) {
  const { session, loading } = useAdminAuth()

  if (loading) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-transparent text-slate-950 dark:text-slate-50">
        <div className="pointer-events-none fixed inset-0 overflow-hidden">
          <div className="absolute -left-20 top-0 h-72 w-72 rounded-full bg-orange-500/12 blur-3xl" style={{ animation: 'beam-float 12s ease-in-out infinite' }} />
          <div className="absolute right-[-4rem] top-16 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" style={{ animation: 'beam-float 16s ease-in-out infinite' }} />
          <div className="beam-grid-lines absolute inset-0 opacity-45 dark:opacity-20" />
        </div>
        <div className="relative flex min-h-screen items-center justify-center px-6 py-10">
          <div className="panel w-full max-w-md px-6 py-8 text-center sm:px-8">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-500 text-white shadow-[0_24px_60px_rgba(249,115,22,0.35)]">
              <Radio size={22} />
            </div>
            <div className="mt-5 text-[11px] font-semibold uppercase tracking-[0.34em] text-orange-600 dark:text-orange-300">
              Beam Control Plane
            </div>
            <div className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">
              Restoring your operator session
            </div>
            <div className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Loading fleet health, workspaces, traces, and partner motion.
            </div>
            <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/60 bg-white/70 px-4 py-2 text-sm text-slate-600 dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-300">
              <LoaderCircle className="animate-spin" size={16} />
              Checking admin session
            </div>
          </div>
        </div>
      </div>
    )
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
            <Route path="partner-ops" element={<PartnerOpsPage />} />
            <Route path="openclaw-fleet" element={<OpenClawFleetPage />} />
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
