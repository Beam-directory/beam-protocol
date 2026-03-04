import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { Activity, Bot, Zap, Settings, Radio } from 'lucide-react'
import clsx from 'clsx'

const NAV_ITEMS = [
  { path: '/', label: 'Overview', icon: Activity, exact: true },
  { path: '/agents', label: 'Agents', icon: Bot },
  { path: '/intents', label: 'Intents', icon: Zap },
  { path: '/settings', label: 'Settings', icon: Settings },
]

export default function Layout() {
  const location = useLocation()

  return (
    <div className="flex h-screen bg-bg overflow-hidden">
      {/* Sidebar */}
      <aside className="w-52 shrink-0 flex flex-col border-r border-border bg-bg-card">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border">
          <div className="w-7 h-7 rounded flex items-center justify-center bg-accent/10 text-accent">
            <Radio size={16} />
          </div>
          <div>
            <div className="text-sm font-bold text-text tracking-tight">BEAM</div>
            <div className="text-xs text-text-muted font-mono -mt-0.5">directory</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 flex flex-col gap-0.5">
          {NAV_ITEMS.map(({ path, label, icon: Icon, exact }) => {
            const active = exact ? location.pathname === path : location.pathname.startsWith(path)
            return (
              <NavLink
                key={path}
                to={path}
                className={clsx(
                  'flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors',
                  active
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-text-muted hover:text-text hover:bg-bg-hover'
                )}
              >
                <Icon size={15} className={active ? 'text-accent' : 'text-text-dim'} />
                {label}
              </NavLink>
            )
          })}
        </nav>

        {/* Bottom status */}
        <div className="p-3 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-text-dim font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-signal-green animate-pulse-slow" />
            beam.directory
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <header className="h-10 flex items-center px-5 border-b border-border bg-bg-card shrink-0">
          <div className="flex-1" />
          <div className="flex items-center gap-4 text-xs text-text-dim font-mono">
            <span className="text-text-muted">BEAM PROTOCOL</span>
            <span>v0.1</span>
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
