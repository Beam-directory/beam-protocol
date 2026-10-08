import { Suspense, lazy } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { SiteShell } from '@/components/site-shell'
import { I18nProvider } from '@/i18n/context'
import { LandingPage } from '@/pages/landing-page'
import { StartPage } from '@/pages/start-page'

// Landing and onboarding (the localized routes) ship in the main bundle, so they render without a layout shift.
// The German-only pages load on demand.
const AgentPage = lazy(() => import('@/pages/agent-page').then((module) => ({ default: module.AgentPage })))
const ApplyPage = lazy(() => import('@/pages/apply-page').then((module) => ({ default: module.ApplyPage })))
const DirectoryPage = lazy(() => import('@/pages/directory-page').then((module) => ({ default: module.DirectoryPage })))
const GuidelinesPage = lazy(() => import('@/pages/guidelines-page').then((module) => ({ default: module.GuidelinesPage })))
const ImpressumPage = lazy(() => import('@/pages/impressum-page').then((module) => ({ default: module.ImpressumPage })))

function PageFallback() {
  return <div className="min-h-[60vh]" aria-hidden="true" />
}

export default function App() {
  return (
    <BrowserRouter>
      <I18nProvider>
        <SiteShell>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              {/* English at /, German under /de. Same element type per route keeps state when switching language. */}
              <Route path="/" element={<LandingPage />} />
              <Route path="/de" element={<LandingPage />} />
              <Route path="/start" element={<StartPage />} />
              <Route path="/de/start" element={<StartPage />} />
              {/* German-only pages, unchanged. */}
              <Route path="/siegel-beantragen" element={<ApplyPage />} />
              <Route path="/verzeichnis" element={<DirectoryPage />} />
              <Route path="/pruefrichtlinien" element={<GuidelinesPage />} />
              <Route path="/impressum" element={<ImpressumPage />} />
              <Route path="/agents/:beamId" element={<AgentPage />} />
              <Route path="/verified/:beamId" element={<AgentPage />} />
            </Routes>
          </Suspense>
        </SiteShell>
      </I18nProvider>
    </BrowserRouter>
  )
}
