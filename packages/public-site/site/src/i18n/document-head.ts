import { headData, ogDescription } from './head.ts'
import { SITE_ORIGIN, type Locale, type LocalizedRoute } from './locale.ts'

function setMeta(attribute: 'name' | 'property', key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`)
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute(attribute, key)
    document.head.appendChild(element)
  }
  element.content = content
}

function setLink(selector: string, attributes: Record<string, string>) {
  let element = document.head.querySelector<HTMLLinkElement>(selector)
  if (!element) {
    element = document.createElement('link')
    document.head.appendChild(element)
  }
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
}

/** Keeps the live document head in sync after client-side navigation between localized routes. */
export function applyDocumentHead(locale: Locale, route: LocalizedRoute) {
  const data = headData(locale, route)
  const ogDesc = ogDescription(data)
  document.documentElement.lang = locale
  document.title = data.title
  setMeta('name', 'description', data.description)
  setLink('link[rel="canonical"]', { rel: 'canonical', href: data.canonical })
  for (const alternate of data.alternates) {
    setLink(`link[rel="alternate"][hreflang="${alternate.hreflang}"]`, { rel: 'alternate', hreflang: alternate.hreflang, href: alternate.href })
  }
  setMeta('property', 'og:locale', data.ogLocale)
  setMeta('property', 'og:locale:alternate', data.ogLocaleAlternate)
  setMeta('property', 'og:title', data.title)
  setMeta('property', 'og:description', ogDesc)
  setMeta('property', 'og:url', data.canonical)
  setMeta('property', 'og:image', data.ogImage)
  setMeta('property', 'og:image:alt', data.ogImageAlt)
  setMeta('name', 'twitter:title', data.title)
  setMeta('name', 'twitter:description', ogDesc)
  setMeta('name', 'twitter:image', data.ogImage)
  setMeta('name', 'twitter:image:alt', data.ogImageAlt)
}

/**
 * German-only routes (/verzeichnis, /agents/…): the shell follows the chosen locale, the page content is German
 * (marked with lang="de" on <main>). They have no language alternates, so drop hreflang and point canonical at itself.
 */
export function applyNonLocalizedHead(locale: Locale, pathname: string) {
  document.documentElement.lang = locale
  document.title = 'Beam'
  document.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((element) => element.remove())
  setLink('link[rel="canonical"]', { rel: 'canonical', href: `${SITE_ORIGIN}${pathname}` })
}
