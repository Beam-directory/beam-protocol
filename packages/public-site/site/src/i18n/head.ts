/**
 * Per-language <head> for the localized routes. Pure (no DOM): used at build time by vite.config.ts to write
 * static HTML for crawlers (/, /start, /verify, /de, /de/start, /de/verify) and at runtime by document-head.ts.
 */
import { de } from './de.ts'
import { en, type Messages } from './en.ts'
import { LOCALES, LOCALIZED_ROUTES, SITE_ORIGIN, absoluteUrl, pathFor, type Locale, type LocalizedRoute } from './locale.ts'

export const DICTIONARIES: Record<Locale, Messages> = { en, de }

export const HEAD_START = '<!-- beam:head:start -->'
export const HEAD_END = '<!-- beam:head:end -->'

export const OG_IMAGE: Record<Locale, string> = {
  en: `${SITE_ORIGIN}/og-image.png`,
  de: `${SITE_ORIGIN}/og-image-de.png`,
}
export const OG_IMAGE_SIZE = { width: 1200, height: 630 }

export interface HeadData {
  locale: Locale
  route: LocalizedRoute
  title: string
  description: string
  canonical: string
  alternates: { hreflang: string; href: string }[]
  ogLocale: string
  ogLocaleAlternate: string
  ogImage: string
  ogImageAlt: string
}

function pageCopy(locale: Locale, route: LocalizedRoute): { title: string; description: string; ogImageAlt: string } {
  const t = DICTIONARIES[locale]
  if (route === 'start') {
    return { title: t.meta.start.title, description: t.meta.start.description, ogImageAlt: t.meta.home.ogImageAlt }
  }
  if (route === 'verify') {
    return { title: t.meta.verify.title, description: t.meta.verify.description, ogImageAlt: t.meta.verify.ogImageAlt }
  }
  return { title: t.meta.home.title, description: t.meta.home.description, ogImageAlt: t.meta.home.ogImageAlt }
}

export function headData(locale: Locale, route: LocalizedRoute): HeadData {
  const t = DICTIONARIES[locale]
  const other: Locale = locale === 'en' ? 'de' : 'en'
  const page = pageCopy(locale, route)
  return {
    locale,
    route,
    title: page.title,
    description: page.description,
    canonical: absoluteUrl(route, locale),
    alternates: [
      ...LOCALES.map((code) => ({ hreflang: code, href: absoluteUrl(route, code) })),
      { hreflang: 'x-default', href: absoluteUrl(route, 'en') },
    ],
    ogLocale: t.meta.ogLocale,
    ogLocaleAlternate: DICTIONARIES[other].meta.ogLocale,
    ogImage: OG_IMAGE[locale],
    ogImageAlt: page.ogImageAlt,
  }
}

/** Open Graph description: the short line for home, the page description for /start. */
export function ogDescription(data: HeadData): string {
  return data.route === 'home' ? DICTIONARIES[data.locale].meta.home.ogDescription : data.description
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderHeadTags(data: HeadData): string {
  const e = escapeHtml
  const ogDesc = ogDescription(data)
  const lines = [
    `<title>${e(data.title)}</title>`,
    `<meta name="description" content="${e(data.description)}" />`,
    `<link rel="canonical" href="${e(data.canonical)}" />`,
    ...data.alternates.map((alt) => `<link rel="alternate" hreflang="${alt.hreflang}" href="${e(alt.href)}" />`),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Beam" />`,
    `<meta property="og:locale" content="${data.ogLocale}" />`,
    `<meta property="og:locale:alternate" content="${data.ogLocaleAlternate}" />`,
    `<meta property="og:title" content="${e(data.title)}" />`,
    `<meta property="og:description" content="${e(ogDesc)}" />`,
    `<meta property="og:url" content="${e(data.canonical)}" />`,
    `<meta property="og:image" content="${e(data.ogImage)}" />`,
    `<meta property="og:image:width" content="${OG_IMAGE_SIZE.width}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE_SIZE.height}" />`,
    `<meta property="og:image:alt" content="${e(data.ogImageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(data.title)}" />`,
    `<meta name="twitter:description" content="${e(ogDesc)}" />`,
    `<meta name="twitter:image" content="${e(data.ogImage)}" />`,
    `<meta name="twitter:image:alt" content="${e(data.ogImageAlt)}" />`,
  ]
  return lines.map((line) => `    ${line}`).join('\n')
}

/** Replaces the marked head block and the <html lang> of a built index.html. */
export function applyHeadToHtml(html: string, locale: Locale, route: LocalizedRoute): string {
  const start = html.indexOf(HEAD_START)
  const end = html.indexOf(HEAD_END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error('index.html is missing the beam:head markers')
  }
  const block = `${HEAD_START}\n${renderHeadTags(headData(locale, route))}\n    ${HEAD_END}`
  const withHead = html.slice(0, start) + block + html.slice(end + HEAD_END.length)
  return withHead.replace(/<html lang="[^"]*"/, `<html lang="${locale}"`)
}

/** Output files for the static per-language entries, relative to the build directory. */
export const HTML_VARIANTS: { file: string; locale: Locale; route: LocalizedRoute }[] = LOCALES.flatMap((locale) =>
  LOCALIZED_ROUTES.map((route) => {
    const path = pathFor(route, locale)
    return { file: path === '/' ? 'index.html' : `${path.slice(1)}/index.html`, locale, route }
  }),
)
