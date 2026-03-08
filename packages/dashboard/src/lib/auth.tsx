import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { DIRECTORY_URL } from './api'

interface Agent {
  beamId: string
  displayName: string
  org: string
  capabilities: string[]
  trustScore: number
  verificationTier: string
  visibility: string
  shieldConfig: any
  plan: string
  httpEndpoint: string | null
  lastSeen: string
  createdAt: string
}

interface AuthUser {
  email: string
  agents: Agent[]
  expiresAt: string
}

interface AuthContextType {
  user: AuthUser | null
  loading: boolean
  login: (email: string) => Promise<{ ok: boolean; url?: string; error?: string }>
  verify: (token: string) => Promise<boolean>
  logout: () => void
  refresh: () => Promise<void>
  selectedAgent: Agent | null
  selectAgent: (beamId: string) => void
}

const AuthContext = createContext<AuthContextType | null>(null)

const TOKEN_KEY = 'beam_session_token'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedBeamId, setSelectedBeamId] = useState<string | null>(() => 
    localStorage.getItem('beam_selected_agent')
  )

  const selectedAgent = user?.agents.find(a => a.beamId === selectedBeamId) || user?.agents[0] || null

  const fetchMe = async (token: string) => {
    try {
      const res = await fetch(`${DIRECTORY_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Session expired')
      const data = await res.json() as AuthUser
      setUser(data)
      if (!selectedBeamId && data.agents.length > 0) {
        setSelectedBeamId(data.agents[0].beamId)
      }
      return true
    } catch {
      localStorage.removeItem(TOKEN_KEY)
      setUser(null)
      return false
    }
  }

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) {
      fetchMe(token).finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [])

  const login = async (email: string) => {
    const res = await fetch(`${DIRECTORY_URL}/auth/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error }
    return { ok: true, url: data.url, token: data.token }
  }

  const verify = async (token: string) => {
    const res = await fetch(`${DIRECTORY_URL}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const data = await res.json()
    if (!res.ok || !data.token) return false
    localStorage.setItem(TOKEN_KEY, data.token)
    await fetchMe(data.token)
    return true
  }

  const logout = () => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) {
      fetch(`${DIRECTORY_URL}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    }
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem('beam_selected_agent')
    setUser(null)
  }

  const refresh = async () => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) await fetchMe(token)
  }

  const selectAgent = (beamId: string) => {
    setSelectedBeamId(beamId)
    localStorage.setItem('beam_selected_agent', beamId)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, verify, logout, refresh, selectedAgent, selectAgent }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
