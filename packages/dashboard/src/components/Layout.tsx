import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Activity, Bot, Globe2, Inbox, Menu, Moon, Radio, ScrollText, Settings, Shield, Sun, TriangleAlert, UserPlus, X, Zap } from 'lucide-react'
import { useAdminAuth } from '../lib/admin-auth'
import { cn } from '../lib/utils'
import { useThemeMode } from '../lib/theme'

const NAV_ITEMS = [
  { path: '/', label: 'Overview', icon: Activity, exact: true },
  { path: '/intents', label: 'Intents', icon: Zap },
  { path: '/audit', label: 'Audit', icon: ScrollText },
  { path: '/agents', label: 'Agents', icon: Bot },
  { path: '/federation', label: 'Federation', icon: Globe2 },
  { path: '/errors', label: 'Errors', icon: TriangleAlert },
  { path: '/alerts', label: 'Alerts', icon: Shield },
  { path: '/dead-letter', label: 'Dead Letters', icon: Inbox },
  { path: '/register', label: 'Register', icon: UserPlus },
  { path: '/settings', label: 'Settings', icon: Settings },
]

export default function Layout() {
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const { theme, toggleTheme } = useThemeMode()
  const { session, logout } = useAdminAuth()

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <div className="flex min-h-screen">
        <div
          className={cn(
            'fixed inset-0 z-40 bg-slate-950/60 transition md:hidden',
            menuOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          onClick={() => setMenuOpen(false)}
        />

        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900 md:static md:w-64 md:max-w-none md:translate-x-0',
            menuOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-4 dark:border-slate-800">
            <Link to="/" className="flex items-center gap-3" onClick={() => setMenuOpen(false)}>
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500">
                <Radio size={18} />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight">Beam Dashboard</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Directory API</div>
              </div>
            </Link>
            <button
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-50 md:hidden"
              onClick={() => setMenuOpen(false)}
              type="button"
            >
              <X size={18} />
            </button>
          </div>

          <nav className="flex-1 space-y-1 p-3">
            {NAV_ITEMS.map(({ path, label, icon: Icon, exact }) => {
              const active = exact ? location.pathname === path : location.pathname.startsWith(path)
              return (
                <NavLink
                  key={path}
                  to={path}
                  onClick={() => setMenuOpen(false)}
                  className={cn(
                    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition',
                    active
                      ? 'bg-orange-500/10 font-medium text-orange-600 dark:text-orange-400'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-50',
                  )}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </NavLink>
              )
            })}
          </nav>

          <div className="border-t border-slate-200 p-4 dark:border-slate-800">
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              live directory connection
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90 sm:px-6">
            <button
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-50 md:hidden"
              onClick={() => setMenuOpen(true)}
              type="button"
            >
              <Menu size={18} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">Beam Protocol Dashboard v2</div>
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {session ? `${session.email} · ${session.role}` : 'Connected to the real directory API'}
              </div>
            </div>
            <button
              className="hidden rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-50 sm:inline-flex"
              onClick={() => void logout()}
              type="button"
            >
              Sign out
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
              onClick={toggleTheme}
              type="button"
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              <span className="hidden sm:inline">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
          </header>

          <div className="flex-1 px-4 py-5 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
