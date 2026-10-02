import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { SiteShell } from '@/components/site-shell'
import { AgentPage } from '@/pages/agent-page'
import { ApplyPage } from '@/pages/apply-page'
import { DirectoryPage } from '@/pages/directory-page'
import { GuidelinesPage } from '@/pages/guidelines-page'
import { ImpressumPage } from '@/pages/impressum-page'
import { LandingPage } from '@/pages/landing-page'

export default function App() {
  return (
    <BrowserRouter>
      <SiteShell>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/siegel-beantragen" element={<ApplyPage />} />
          <Route path="/verzeichnis" element={<DirectoryPage />} />
          <Route path="/pruefrichtlinien" element={<GuidelinesPage />} />
          <Route path="/impressum" element={<ImpressumPage />} />
          <Route path="/agents/:beamId" element={<AgentPage />} />
          <Route path="/verified/:beamId" element={<AgentPage />} />
        </Routes>
      </SiteShell>
    </BrowserRouter>
  )
}
