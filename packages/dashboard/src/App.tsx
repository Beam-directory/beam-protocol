import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import AgentProfilePage from './pages/AgentProfilePage'
import AgentsPage from './pages/AgentsPage'
import AlertsPage from './pages/AlertsPage'
import AuditPage from './pages/AuditPage'
import DeadLetterPage from './pages/DeadLetterPage'
import ErrorsPage from './pages/ErrorsPage'
import FederationPage from './pages/FederationPage'
import IntentsPage from './pages/IntentsPage'
import OverviewPage from './pages/OverviewPage'
import RegisterPage from './pages/RegisterPage'
import SettingsPage from './pages/SettingsPage'
import TraceDetailPage from './pages/TraceDetailPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="intents" element={<IntentsPage />} />
          <Route path="intents/:nonce" element={<TraceDetailPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:beamId" element={<AgentProfilePage />} />
          <Route path="federation" element={<FederationPage />} />
          <Route path="errors" element={<ErrorsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="dead-letter" element={<DeadLetterPage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
