import { useState, type ReactNode } from 'react'
import { ArrowUpRightIcon, MenuIcon, MoonIcon, SunIcon, XIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from 'cn'
import { BeamMark } from '@/components/beam-mark'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'
import { LOCALES, shouldShowLanguageHint, switchPath, type Locale } from '@/i18n/locale'
import { CONTACT_EMAIL } from '@/lib/register'

const DOCS_URL = 'https://docs.beam.directory'
const DASHBOARD_URL = 'https://dashboard.beam.directory'

const LANGUAGE_NAMES: Record<Locale, { short: string; name: string }> = {
  en: { short: 'EN', name: 'English' },
  de: { short: 'DE', name: 'Deutsch' },
}

/** `germanOnly`: the target page exists in German only (marked "DE" in the English shell). */
type NavItem = { label: string; to?: string; href?: string; external?: boolean; germanOnly?: boolean }

function GermanOnlyMarker() {
  const { locale, t } = useI18n()
  if (locale === 'de') return null
  return (
    <>
      <span aria-hidden="true" className="ml-1 rounded border px-1 py-px text-[10px] leading-none font-medium text-muted-foreground">DE</span>
      <span className="sr-only"> ({t.common.germanOnly})</span>
    </>
  )
}

function NavLink({ item, className, onNavigate }: { item: NavItem; className?: string; onNavigate?: () => void }) {
  const hrefLang = item.germanOnly ? 'de' : undefined
  if (item.to) {
    return (
      <Link className={className} to={item.to} onClick={onNavigate} hrefLang={hrefLang}>
        {item.label}
        {item.germanOnly ? <GermanOnlyMarker /> : null}
      </Link>
    )
  }
  return (
    <a className={className} href={item.href} onClick={onNavigate} hrefLang={hrefLang}>
      {item.label}
      {item.external ? <ArrowUpRightIcon aria-hidden="true" className="ml-0.5 inline size-3 opacity-60" /> : null}
      {item.germanOnly ? <GermanOnlyMarker /> : null}
    </a>
  )
}

function ThemeToggle() {
  const { setTheme } = useTheme()
  const { t } = useI18n()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t.common.toggleTheme}
      title={t.common.toggleTheme}
      onClick={() => setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark')}
    >
      <SunIcon aria-hidden="true" className="hidden dark:block" />
      <MoonIcon aria-hidden="true" className="dark:hidden" />
    </Button>
  )
}

/** EN/DE switcher. Stores the explicit choice; localized routes jump to their counterpart, others stay. */
function LanguageSwitcher({ className, full = false, onNavigate }: { className?: string; full?: boolean; onNavigate?: () => void }) {
  const { locale, chooseLocale, t } = useI18n()
  const { pathname } = useLocation()
  return (
    <div role="group" aria-label={t.common.language} className={cn('flex items-center rounded-full border p-0.5', className)}>
      {LOCALES.map((code) => {
        const active = code === locale
        return (
          <Link
            key={code}
            to={switchPath(pathname, code)}
            hrefLang={code}
            lang={code}
            aria-current={active ? 'true' : undefined}
            onClick={() => {
              chooseLocale(code)
              onNavigate?.()
            }}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              full && 'px-4 py-1.5 text-sm',
            )}
          >
            {full ? LANGUAGE_NAMES[code].name : LANGUAGE_NAMES[code].short}
            {full ? null : <span className="sr-only"> {LANGUAGE_NAMES[code].name}</span>}
          </Link>
        )
      })}
    </div>
  )
}

/** First visit to "/" with a German browser: a dismissible hint, never an automatic redirect. */
function LanguageHint() {
  const { storedLocale, chooseLocale } = useI18n()
  const { pathname } = useLocation()
  const languages = typeof navigator !== 'undefined' ? navigator.languages : undefined
  if (!shouldShowLanguageHint(pathname, storedLocale, languages)) return null
  return (
    <div lang="de" className="border-b border-border/60 bg-muted/60">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-2 text-sm sm:px-6">
        <p>
          Auf Deutsch lesen?{' '}
          <Link to="/de" hrefLang="de" onClick={() => chooseLocale('de')} className="font-medium underline underline-offset-4">
            Zur deutschen Version
          </Link>
        </p>
        <button
          type="button"
          onClick={() => chooseLocale('en')}
          aria-label="Hinweis schließen"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  )
}

export function SiteShell({ children }: { children: ReactNode }) {
  const { t, href, localized } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const fullBleed = localized !== null
  const closeMenu = () => setMenuOpen(false)

  const primaryNav: NavItem[] = [
    { label: t.shell.nav.directory, to: '/verzeichnis', germanOnly: true },
    { label: t.shell.nav.seal, to: '/siegel-beantragen', germanOnly: true },
    { label: t.shell.nav.guidelines, to: '/pruefrichtlinien', germanOnly: true },
    { label: t.shell.nav.docs, href: DOCS_URL, external: true },
  ]

  const links = t.shell.footer.links
  const footerColumns: { title: string; items: NavItem[] }[] = [
    {
      title: t.shell.footer.columns.product,
      items: [
        { label: links.connectAgent, to: href('start') },
        { label: links.openNetwork, href: '/network' },
        { label: links.dashboard, href: DASHBOARD_URL, external: true },
        { label: links.directory, to: '/verzeichnis', germanOnly: true },
        { label: links.applySeal, to: '/siegel-beantragen', germanOnly: true },
      ],
    },
    {
      title: t.shell.footer.columns.developers,
      items: [
        { label: links.docs, href: DOCS_URL, external: true },
        { label: links.status, href: '/status.html' },
        { label: links.guidelines, to: '/pruefrichtlinien', germanOnly: true },
      ],
    },
    {
      title: t.shell.footer.columns.legal,
      items: [
        { label: links.imprint, to: '/impressum', germanOnly: true },
        { label: links.privacy, href: '/privacy.html' },
        { label: links.terms, href: '/terms.html' },
        { label: links.contact, href: `mailto:${CONTACT_EMAIL}` },
      ],
    },
  ]

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <a
        href="#inhalt"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t.common.skipToContent}
      </a>
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to={href('home')} className="flex items-center gap-2 rounded-md" aria-label={t.common.homeAria} onClick={closeMenu}>
            <BeamMark className="size-7" />
            <span className="text-[15px] font-semibold tracking-tight">Beam</span>
          </Link>
          <nav className="ml-6 hidden items-center gap-1 md:flex" aria-label={t.common.mainNav}>
            {primaryNav.map((item) => (
              <NavLink
                key={item.label}
                item={item}
                className="inline-flex items-center rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <LanguageSwitcher className="hidden md:flex" />
            <ThemeToggle />
            <Button variant="ghost" className="hidden h-8 px-3 lg:inline-flex" asChild>
              <a href={DASHBOARD_URL}>{t.shell.dashboard}</a>
            </Button>
            <Button className="hidden h-8 rounded-full px-3.5 sm:inline-flex" asChild>
              <Link to={href('start')} onClick={closeMenu}>{t.shell.connectAgent}</Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? t.common.closeMenu : t.common.openMenu}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
            </Button>
          </div>
        </div>
        {menuOpen ? (
          <nav id="mobile-nav" className="border-t border-border/60 bg-background md:hidden" aria-label={t.common.mobileNav}>
            <ul className="mx-auto flex max-w-6xl flex-col px-4 py-2">
              {primaryNav.map((item) => (
                <li key={item.label}>
                  <NavLink item={item} onNavigate={closeMenu} className="flex items-center py-3 text-base text-foreground" />
                </li>
              ))}
              <li>
                <NavLink item={{ label: t.shell.dashboard, href: DASHBOARD_URL, external: true }} onNavigate={closeMenu} className="flex items-center py-3 text-base text-foreground" />
              </li>
              <li>
                <NavLink item={{ label: t.shell.openNetwork, href: '/network' }} onNavigate={closeMenu} className="flex items-center py-3 text-base text-foreground" />
              </li>
              <li className="py-3">
                <LanguageSwitcher full onNavigate={closeMenu} className="w-fit" />
              </li>
              <li className="py-3">
                <Button className="h-10 w-full rounded-full" asChild>
                  <Link to={href('start')} onClick={closeMenu}>{t.shell.connectAgent}</Link>
                </Button>
              </li>
            </ul>
          </nav>
        ) : null}
      </header>
      <LanguageHint />
      <main
        id="inhalt"
        lang={localized ? undefined : 'de'}
        className={fullBleed ? 'flex w-full flex-1 flex-col' : 'mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-10 sm:px-6'}
      >
        {children}
      </main>
      <footer className="border-t border-border/60">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 text-sm sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="flex flex-col gap-3">
            <Link to={href('home')} className="flex w-fit items-center gap-2 rounded-md" aria-label={t.common.homeAria}>
              <BeamMark className="size-6" />
              <span className="font-semibold tracking-tight">Beam</span>
            </Link>
            <p className="max-w-xs text-muted-foreground">{t.shell.footer.tagline}</p>
            <p className="max-w-xs text-xs leading-5 text-muted-foreground">{t.shell.footer.legalNote}</p>
            <p className="text-xs text-muted-foreground">{t.shell.footer.asOf}</p>
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
