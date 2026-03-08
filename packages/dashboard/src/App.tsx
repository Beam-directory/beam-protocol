import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import AgentProfilePage from './pages/AgentProfilePage'
import AgentsPage from './pages/AgentsPage'
import IntentsPage from './pages/IntentsPage'
import OverviewPage from './pages/OverviewPage'
import RegisterPage from './pages/RegisterPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:beamId" element={<AgentProfilePage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="intents" element={<IntentsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
