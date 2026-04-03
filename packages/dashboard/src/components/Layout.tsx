import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Activity, BellDot, Bot, Building2, FileText, Globe2, Inbox, Menu, Moon, Radio, ScrollText, ServerCog, Settings, Shield, Sun, TriangleAlert, TrendingUp, UserPlus, X, Zap } from 'lucide-react'
import { useAdminAuth } from '../lib/admin-auth'
import { cn } from '../lib/utils'
import { useThemeMode } from '../lib/theme'

const NAV_ITEMS = [
  { path: '/', label: 'Overview', icon: Activity, exact: true },
  { path: '/intents', label: 'Intents', icon: Zap },
  { path: '/audit', label: 'Audit', icon: ScrollText },
  { path: '/agents', label: 'Agents', icon: Bot },
  { path: '/federation', label: 'Federation', icon: Globe2 },
  { path: '/funnel', label: 'Funnel', icon: TrendingUp },
  { path: '/errors', label: 'Errors', icon: TriangleAlert },
  { path: '/alerts', label: 'Alerts', icon: Shield },
  { path: '/inbox', label: 'Inbox', icon: BellDot },
  { path: '/beta-requests', label: 'Beta Requests', icon: FileText },
  { path: '/partner-ops', label: 'Partner Ops', icon: TriangleAlert },
  { path: '/openclaw-fleet', label: 'OpenClaw Fleet', icon: ServerCog },
  { path: '/workspaces', label: 'Workspaces', icon: Building2 },
  { path: '/dead-letter', label: 'Dead Letters', icon: Inbox },
  { path: '/register', label: 'Register', icon: UserPlus },
  { path: '/settings', label: 'Settings', icon: Settings },
]

export default function Layout() {
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const { theme, toggleTheme } = useThemeMode()
  const { session, logout } = useAdminAuth()
  const activeNavItem = NAV_ITEMS.find(({ path, exact }) => (
    exact ? location.pathname === path : location.pathname.startsWith(path)
  )) ?? NAV_ITEMS[0]

  return (
    <div className="min-h-screen overflow-hidden bg-transparent text-slate-950 dark:text-slate-50">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-0 h-80 w-80 rounded-full bg-orange-500/12 blur-3xl" style={{ animation: 'beam-float 12s ease-in-out infinite' }} />
        <div className="absolute right-[-6rem] top-24 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" style={{ animation: 'beam-float 18s ease-in-out infinite' }} />
        <div className="beam-grid-lines absolute inset-0 opacity-50 dark:opacity-20" />
      </div>

      <div className="relative flex min-h-screen">
        <div
          className={cn(
            'fixed inset-0 z-40 bg-slate-950/60 transition md:hidden',
            menuOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          onClick={() => setMenuOpen(false)}
        />

        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-slate-950/88 text-slate-50 shadow-[0_32px_120px_rgba(2,6,23,0.38)] backdrop-blur-2xl transition-transform md:static md:w-72 md:max-w-none md:translate-x-0',
            menuOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-5">
            <Link to="/" className="flex items-center gap-3" onClick={() => setMenuOpen(false)}>
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-orange-500 text-white shadow-[0_20px_40px_rgba(249,115,22,0.35)]">
                <Radio size={18} />
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.34em] text-orange-300/90">Beam</div>
                <div className="text-base font-semibold tracking-tight text-white">Control Plane</div>
              </div>
            </Link>
            <button
              className="rounded-xl p-2 text-slate-400 hover:bg-white/10 hover:text-white md:hidden"
              onClick={() => setMenuOpen(false)}
              type="button"
            >
              <X size={18} />
            </button>
          </div>

          <nav className="flex-1 space-y-1.5 p-4">
            {NAV_ITEMS.map(({ path, label, icon: Icon, exact }) => {
              const active = exact ? location.pathname === path : location.pathname.startsWith(path)
              return (
                <NavLink
                  key={path}
                  to={path}
                  onClick={() => setMenuOpen(false)}
                  className={cn(
                    'flex items-center gap-3 rounded-2xl px-3.5 py-3 text-sm transition',
                    active
                      ? 'bg-white text-slate-950 shadow-[0_18px_50px_rgba(255,255,255,0.15)]'
                      : 'text-slate-300 hover:bg-white/8 hover:text-white',
                  )}
                >
                  <span className={cn('flex h-8 w-8 items-center justify-center rounded-xl', active ? 'bg-orange-500/12 text-orange-600' : 'bg-white/5 text-slate-300')}>
                    <Icon size={16} />
                  </span>
                  <span>{label}</span>
                </NavLink>
              )
            })}
          </nav>

          <div className="border-t border-white/10 p-4">
            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4 text-xs text-slate-300">
              <div className="flex items-center gap-2 font-semibold uppercase tracking-[0.22em] text-slate-400">
                <span className="beam-status-dot h-2.5 w-2.5 rounded-full bg-emerald-400" />
                Live directory
              </div>
              <div className="mt-2 leading-5 text-slate-400">
                One operator surface for fleet health, workspaces, traces, and partner motion.
              </div>
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-20 items-center gap-3 border-b border-white/30 bg-white/55 px-4 backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55 sm:px-6">
            <button
              className="rounded-xl p-2 text-slate-500 hover:bg-white/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/80 dark:hover:text-slate-50 md:hidden"
              onClick={() => setMenuOpen(true)}
              type="button"
            >
              <Menu size={18} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">Beam Command</div>
              <div className="truncate text-lg font-semibold tracking-tight">{activeNavItem.label}</div>
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {session ? `${session.email} · ${session.role}` : 'Connected to the real directory API'}
              </div>
            </div>
            <div className="hidden items-center gap-2 rounded-full border border-white/50 bg-white/65 px-3 py-1.5 text-xs font-medium text-slate-600 shadow-[0_10px_30px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/70 dark:text-slate-300 lg:flex">
              <span className="beam-status-dot h-2.5 w-2.5 rounded-full bg-emerald-400" />
              Directory live
            </div>
            <button
              className="hidden rounded-2xl border border-white/60 bg-white/65 px-3 py-2 text-sm text-slate-600 transition hover:bg-white dark:border-white/10 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-slate-50 sm:inline-flex"
              onClick={() => void logout()}
              type="button"
            >
              Sign out
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-2xl border border-white/60 bg-white/65 px-3 py-2 text-sm text-slate-600 transition hover:bg-white dark:border-white/10 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-slate-900"
              onClick={toggleTheme}
              type="button"
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              <span className="hidden sm:inline">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
          </header>

          <div key={location.pathname} className="beam-page-enter flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <div className="mx-auto flex w-full max-w-[1640px] flex-col gap-6">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
