/**
 * Locale routing. Pure functions only (also imported by vite.config.ts at build time, so no DOM types here).
 *
 * Rules:
 * - The URL always wins: `/` and `/start` are English, `/de` and `/de/start` are German.
 * - Other routes (/verzeichnis, /pruefrichtlinien, …) have German content only; their shell follows the stored choice.
 * - The language switcher stores the explicit choice in localStorage (LOCALE_STORAGE_KEY).
 * - First visit to `/` without a stored choice: if navigator.languages starts with "de", show a dismissible hint
 *   that links to `/de`. No automatic redirect.
 * - Later visits to exactly `/` with a stored "de" choice redirect client-side to `/de`. Choosing English stores "en".
 */

export const LOCALES = ['en', 'de'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_STORAGE_KEY = 'beam.locale'

export type LocalizedRoute = 'home' | 'start'
export const LOCALIZED_ROUTES: LocalizedRoute[] = ['home', 'start']

export const SITE_ORIGIN = 'https://beam.directory'

const ROUTE_SUFFIX: Record<LocalizedRoute, string> = { home: '', start: '/start' }

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'de'
}

/** Path of a localized route, e.g. pathFor('start', 'de') === '/de/start'. */
export function pathFor(route: LocalizedRoute, locale: Locale): string {
  const suffix = ROUTE_SUFFIX[route]
  if (locale === 'en') return suffix || '/'
  return `/de${suffix}`
}

export function absoluteUrl(route: LocalizedRoute, locale: Locale): string {
  const path = pathFor(route, locale)
  return path === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path}`
}

/** Locale and route for one of the four localized paths; null for every other route. */
export function parseLocalizedPath(pathname: string): { locale: Locale; route: LocalizedRoute } | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  for (const locale of LOCALES) {
    for (const route of LOCALIZED_ROUTES) {
      if (pathFor(route, locale) === path) return { locale, route }
    }
  }
  return null
}

/**
 * Target of the language switcher. Localized routes map to their counterpart; German-only routes stay on the same
 * path (only the shell language changes).
 */
export function switchPath(pathname: string, target: Locale): string {
  const parsed = parseLocalizedPath(pathname)
  return parsed ? pathFor(parsed.route, target) : pathname
}

/** Locale to suggest from navigator.languages. Only a hint; never used for a redirect on its own. */
export function browserHintLocale(languages: readonly string[] | undefined): Locale | null {
  const first = languages?.[0]?.toLowerCase() ?? ''
  return first.startsWith('de') ? 'de' : null
}

/** Client-side redirect for a returning visitor on `/` who chose German before. */
export function storedLocaleRedirect(pathname: string, stored: Locale | null): string | null {
  return pathname === '/' && stored === 'de' ? '/de' : null
}

/** Whether to show the "Auf Deutsch lesen?" hint. */
export function shouldShowLanguageHint(pathname: string, stored: Locale | null, languages: readonly string[] | undefined): boolean {
  return pathname === '/' && stored === null && browserHintLocale(languages) === 'de'
}

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function readStoredLocale(storage: StorageLike | null): Locale | null {
  try {
    const value = storage?.getItem(LOCALE_STORAGE_KEY) ?? null
    return isLocale(value) ? value : null
  } catch {
    return null
  }
}

export function writeStoredLocale(storage: StorageLike | null, locale: Locale): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Storage may be disabled; the URL still decides the language.
  }
}

/** BCP 47 tag for Intl formatting. */
export function intlLocale(locale: Locale): string {
  return locale === 'de' ? 'de-DE' : 'en-GB'
}
