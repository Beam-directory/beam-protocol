import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  adminAuthApi,
  ApiError,
  clearStoredAdminSessionToken,
  getStoredAdminSessionToken,
  setStoredAdminSessionToken,
  type AdminAuthConfig,
  type AdminMagicLinkResponse,
  type AdminSessionInfo,
} from './api'

type AdminAuthContextValue = {
  session: AdminSessionInfo | null
  config: AdminAuthConfig | null
  loading: boolean
  login: (email: string) => Promise<AdminMagicLinkResponse>
  verify: (token: string) => Promise<boolean>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null)

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AdminSessionInfo | null>(null)
  const [config, setConfig] = useState<AdminAuthConfig | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadConfig() {
    try {
      const nextConfig = await adminAuthApi.getConfig()
      setConfig(nextConfig)
    } catch {
      setConfig(null)
    }
  }

  async function refresh() {
    try {
      const nextSession = await adminAuthApi.getSession()
      setSession(nextSession)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearStoredAdminSessionToken()
        setSession(null)
        return
      }

      throw error
    }
  }

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        await loadConfig()
        if (cancelled) return
        await refresh()
      } catch {
        if (!cancelled) {
          clearStoredAdminSessionToken()
          setSession(null)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  async function login(email: string) {
    const response = await adminAuthApi.requestMagicLink(email)
    await loadConfig()
    return response
  }

  async function verify(token: string) {
    const sessionResponse = await adminAuthApi.verify(token)
    if (sessionResponse.token) {
      setStoredAdminSessionToken(sessionResponse.token)
    } else if (!getStoredAdminSessionToken()) {
      clearStoredAdminSessionToken()
    }
    setSession({
      email: sessionResponse.email,
      role: sessionResponse.role,
      expiresAt: sessionResponse.expiresAt,
    })
    await loadConfig()
    return true
  }

  async function logout() {
    try {
      await adminAuthApi.logout()
    } catch {
      // Best-effort logout; local token still needs to be cleared.
    } finally {
      clearStoredAdminSessionToken()
      setSession(null)
    }
  }

  return (
    <AdminAuthContext.Provider value={{ session, config, loading, login, verify, logout, refresh }}>
      {children}
    </AdminAuthContext.Provider>
  )
}

export function useAdminAuth() {
  const context = useContext(AdminAuthContext)
  if (!context) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider')
  }

  return context
}
