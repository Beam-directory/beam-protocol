import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import LoginPage from './pages/LoginPage'
import AuthCallbackPage from './pages/AuthCallbackPage'
import DashboardPage from './pages/DashboardPage'
import AgentsPage from './pages/AgentsPage'
import IntentsPage from './pages/IntentsPage'
import SettingsPage from './pages/SettingsPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#FAFAFA',
      }}>
        <div style={{
          width: '32px',
          height: '32px',
          border: '3px solid #E4E4E7',
          borderTopColor: '#F75C03',
          borderRadius: '50%',
          animation: 'spin 0.6s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
      <Route path="/agents" element={<ProtectedRoute><AgentsPage /></ProtectedRoute>} />
      <Route path="/intents" element={<ProtectedRoute><IntentsPage /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
