import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { applyDocumentHead, applyNonLocalizedHead } from './document-head.ts'
import { DICTIONARIES } from './head.ts'
import type { Messages } from './en.ts'
import {
  DEFAULT_LOCALE,
  parseLocalizedPath,
  pathFor,
  readStoredLocale,
  storedLocaleRedirect,
  writeStoredLocale,
  type Locale,
  type LocalizedRoute,
} from './locale.ts'

interface I18nValue {
  /** Language of the shell and of localized pages. The URL wins; otherwise the stored choice; otherwise English. */
  locale: Locale
  t: Messages
  /** Locale and route when the current path is one of /, /start, /verify, /de, /de/start, /de/verify. */
  localized: { locale: Locale; route: LocalizedRoute } | null
  /** The explicit choice from the language switcher, if any. */
  storedLocale: Locale | null
  /** Path of a localized route in the current language. */
  href: (route: LocalizedRoute) => string
  /** Stores an explicit language choice (switcher, hint banner). */
  chooseLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nValue | null>(null)

function localStore(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const [storedLocale, setStoredLocale] = useState<Locale | null>(() => readStoredLocale(localStore()))
  const localized = parseLocalizedPath(pathname)
  const locale = localized?.locale ?? storedLocale ?? DEFAULT_LOCALE

  const value = useMemo<I18nValue>(() => ({
    locale,
    t: DICTIONARIES[locale],
    localized: parseLocalizedPath(pathname),
    storedLocale,
    href: (route) => pathFor(route, locale),
    chooseLocale: (next) => {
      writeStoredLocale(localStore(), next)
      setStoredLocale(next)
    },
  }), [locale, storedLocale, pathname])

  // The document head is the external system here: language, title, canonical and hreflang per route.
  useEffect(() => {
    const parsed = parseLocalizedPath(pathname)
    if (parsed) applyDocumentHead(parsed.locale, parsed.route)
    else applyNonLocalizedHead(locale, pathname)
  }, [pathname, locale])

  // Returning visitor who chose German before, landing on exactly "/": send them to "/de". Never for explicit /de… URLs.
  const redirect = storedLocaleRedirect(pathname, storedLocale)
  if (redirect) return <Navigate to={redirect} replace />

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside I18nProvider')
  return context
}
