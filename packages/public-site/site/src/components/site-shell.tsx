import { useState, type ReactNode } from 'react'
import { ArrowUpRightIcon, MenuIcon, MoonIcon, SunIcon, XIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { BeamMark } from '@/components/beam-mark'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { CONTACT_EMAIL, REGISTER_AS_OF } from '@/lib/register'

const DOCS_URL = 'https://docs.beam.directory'
const DASHBOARD_URL = 'https://dashboard.beam.directory'

type NavItem = { label: string; to?: string; href?: string; external?: boolean }

const primaryNav: NavItem[] = [
  { label: 'Verzeichnis', to: '/verzeichnis' },
  { label: 'Siegel', to: '/siegel-beantragen' },
  { label: 'Prüfrichtlinien', to: '/pruefrichtlinien' },
  { label: 'Docs', href: DOCS_URL, external: true },
]

const footerColumns: { title: string; items: NavItem[] }[] = [
  {
    title: 'Produkt',
    items: [
      { label: 'Agent verbinden', to: '/start' },
      { label: 'Netzwerk öffnen', href: '/network' },
      { label: 'Dashboard', href: DASHBOARD_URL, external: true },
      { label: 'Verzeichnis', to: '/verzeichnis' },
      { label: 'Siegel beantragen', to: '/siegel-beantragen' },
    ],
  },
  {
    title: 'Entwickler',
    items: [
      { label: 'Dokumentation', href: DOCS_URL, external: true },
      { label: 'Status', href: '/status.html' },
      { label: 'Prüfrichtlinien', to: '/pruefrichtlinien' },
    ],
  },
  {
    title: 'Rechtliches',
    items: [
      { label: 'Impressum', to: '/impressum' },
      { label: 'Datenschutz', href: '/privacy.html' },
      { label: 'AGB', href: '/terms.html' },
      { label: 'Kontakt', href: `mailto:${CONTACT_EMAIL}` },
    ],
  },
]

function NavLink({ item, className, onNavigate }: { item: NavItem; className?: string; onNavigate?: () => void }) {
  if (item.to) {
    return (
      <Link className={className} to={item.to} onClick={onNavigate}>
        {item.label}
      </Link>
    )
  }
  return (
    <a className={className} href={item.href} onClick={onNavigate}>
      {item.label}
      {item.external ? <ArrowUpRightIcon aria-hidden="true" className="ml-0.5 inline size-3 opacity-60" /> : null}
    </a>
  )
}

function ThemeToggle() {
  const { setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Hell- oder Dunkelmodus umschalten"
      title="Hell- oder Dunkelmodus umschalten"
      onClick={() => setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark')}
    >
      <SunIcon aria-hidden="true" className="hidden dark:block" />
      <MoonIcon aria-hidden="true" className="dark:hidden" />
    </Button>
  )
}

export function SiteShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const fullBleed = pathname === '/' || pathname === '/start'
  const closeMenu = () => setMenuOpen(false)

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <a
        href="#inhalt"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Zum Inhalt springen
      </a>
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 rounded-md" aria-label="Beam, zur Startseite" onClick={closeMenu}>
            <BeamMark className="size-7" />
            <span className="text-[15px] font-semibold tracking-tight">Beam</span>
          </Link>
          <nav className="ml-6 hidden items-center gap-1 md:flex" aria-label="Hauptnavigation">
            {primaryNav.map((item) => (
              <NavLink
                key={item.label}
                item={item}
                className="inline-flex items-center rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <Button variant="ghost" className="hidden h-8 px-3 sm:inline-flex" asChild>
              <a href={DASHBOARD_URL}>Dashboard</a>
            </Button>
            <Button className="hidden h-8 rounded-full px-3.5 sm:inline-flex" asChild>
              <Link to="/start" onClick={closeMenu}>Agent verbinden</Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? 'Menü schließen' : 'Menü öffnen'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
            </Button>
          </div>
        </div>
        {menuOpen ? (
          <nav id="mobile-nav" className="border-t border-border/60 bg-background md:hidden" aria-label="Mobile Navigation">
            <ul className="mx-auto flex max-w-6xl flex-col px-4 py-2">
              {primaryNav.map((item) => (
                <li key={item.label}>
                  <NavLink item={item} onNavigate={closeMenu} className="flex items-center py-3 text-base text-foreground" />
                </li>
              ))}
              <li>
                <NavLink item={{ label: 'Dashboard', href: DASHBOARD_URL, external: true }} onNavigate={closeMenu} className="flex items-center py-3 text-base text-foreground" />
              </li>
              <li>
                <NavLink item={{ label: 'Netzwerk öffnen', href: '/network' }} onNavigate={closeMenu} className="flex items-center py-3 text-base text-foreground" />
              </li>
              <li className="py-3">
                <Button className="h-10 w-full rounded-full" asChild>
                  <Link to="/start" onClick={closeMenu}>Agent verbinden</Link>
                </Button>
              </li>
            </ul>
          </nav>
        ) : null}
      </header>
      <main
        id="inhalt"
        className={fullBleed ? 'flex w-full flex-1 flex-col' : 'mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-10 sm:px-6'}
      >
        {children}
      </main>
      <footer className="border-t border-border/60">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 text-sm sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="flex flex-col gap-3">
            <Link to="/" className="flex w-fit items-center gap-2 rounded-md" aria-label="Beam, zur Startseite">
              <BeamMark className="size-6" />
              <span className="font-semibold tracking-tight">Beam</span>
            </Link>
            <p className="max-w-xs text-muted-foreground">Die Vertrauensschicht für KI-Agenten. Geprüft, signiert, Ende-zu-Ende verschlüsselt.</p>
            <p className="max-w-xs text-xs leading-5 text-muted-foreground">
              Beam ist ein privates Unternehmen. Das Register ist keine Behörde und kein Zeichen der Europäischen Union.
            </p>
            <p className="text-xs text-muted-foreground">Stand: {REGISTER_AS_OF}</p>
          </div>
          {footerColumns.map((column) => (
            <nav key={column.title} className="flex flex-col gap-2.5" aria-label={column.title}>
              <p className="text-xs font-medium tracking-wide text-foreground uppercase">{column.title}</p>
              {column.items.map((item) => (
                <NavLink key={item.label} item={item} className="w-fit text-muted-foreground transition-colors hover:text-foreground" />
              ))}
            </nav>
          ))}
        </div>
      </footer>
    </div>
  )
}
