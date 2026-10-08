import { describe, expect, it } from 'vitest'
import { de } from './de.ts'
import { en } from './en.ts'
import { HEAD_END, HEAD_START, HTML_VARIANTS, applyHeadToHtml, headData, renderHeadTags } from './head.ts'
import {
  browserHintLocale,
  parseLocalizedPath,
  pathFor,
  readStoredLocale,
  shouldShowLanguageHint,
  storedLocaleRedirect,
  switchPath,
  writeStoredLocale,
} from './locale.ts'

function keysDeep(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => keysDeep(item, `${prefix}[${index}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => keysDeep(child, prefix ? `${prefix}.${key}` : key))
  }
  return [prefix]
}

describe('dictionaries', () => {
  it('have the same keys and array lengths in both languages (types enforce most of this; codes are a Record)', () => {
    expect(keysDeep(de).sort()).toEqual(keysDeep(en).sort())
  })

  it('keep the facts aligned: E2E only for /network chats and files, MCP handoffs not E2E', () => {
    expect(en.landing.faq.items[1].a).toContain('without end-to-end encryption')
    expect(de.landing.faq.items[1].a).toContain('ohne Ende-zu-Ende-Verschlüsselung')
    expect(en.landing.hero.badge).toBe('Verified · Signed · Encrypted chats')
    expect(de.landing.hero.badge).toBe('Geprüft · Signiert · Chats verschlüsselt')
    expect(en.landing.features.grok.badge).toBe('Sending in progress')
  })
})

describe('locale routing', () => {
  it('maps the six localized paths', () => {
    expect(parseLocalizedPath('/')).toEqual({ locale: 'en', route: 'home' })
    expect(parseLocalizedPath('/start')).toEqual({ locale: 'en', route: 'start' })
    expect(parseLocalizedPath('/verify')).toEqual({ locale: 'en', route: 'verify' })
    expect(parseLocalizedPath('/de')).toEqual({ locale: 'de', route: 'home' })
    expect(parseLocalizedPath('/de/')).toEqual({ locale: 'de', route: 'home' })
    expect(parseLocalizedPath('/de/start')).toEqual({ locale: 'de', route: 'start' })
    expect(parseLocalizedPath('/de/verify')).toEqual({ locale: 'de', route: 'verify' })
    expect(parseLocalizedPath('/verzeichnis')).toBeNull()
    expect(parseLocalizedPath('/agents/a%40b.beam.directory')).toBeNull()
  })

  it('builds paths and switcher targets', () => {
    expect(pathFor('home', 'en')).toBe('/')
    expect(pathFor('start', 'de')).toBe('/de/start')
    expect(pathFor('verify', 'de')).toBe('/de/verify')
    expect(switchPath('/start', 'de')).toBe('/de/start')
    expect(switchPath('/verify', 'de')).toBe('/de/verify')
    expect(switchPath('/de', 'en')).toBe('/')
    expect(switchPath('/verzeichnis', 'en')).toBe('/verzeichnis')
  })

  it('uses the browser language only as a hint and redirects only returning German visitors on /', () => {
    expect(browserHintLocale(['de-AT', 'en'])).toBe('de')
    expect(browserHintLocale(['en-US', 'de'])).toBeNull()
    expect(shouldShowLanguageHint('/', null, ['de-DE'])).toBe(true)
    expect(shouldShowLanguageHint('/', 'en', ['de-DE'])).toBe(false)
    expect(shouldShowLanguageHint('/start', null, ['de-DE'])).toBe(false)
    expect(storedLocaleRedirect('/', 'de')).toBe('/de')
    expect(storedLocaleRedirect('/', 'en')).toBeNull()
    expect(storedLocaleRedirect('/', null)).toBeNull()
    expect(storedLocaleRedirect('/start', 'de')).toBeNull()
    expect(storedLocaleRedirect('/de', 'de')).toBeNull()
  })

  it('stores only valid locales', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
    expect(readStoredLocale(storage)).toBeNull()
    writeStoredLocale(storage, 'de')
    expect(readStoredLocale(storage)).toBe('de')
    data.set('beam.locale', 'fr')
    expect(readStoredLocale(storage)).toBeNull()
  })
})

describe('per-language head', () => {
  const template = `<!doctype html>\n<html lang="en">\n  <head>\n    ${HEAD_START}\n    <title>x</title>\n    ${HEAD_END}\n  </head>\n</html>`

  it('renders German meta, canonical, hreflang and the German og-image for /de', () => {
    const html = applyHeadToHtml(template, 'de', 'home')
    expect(html).toContain('<html lang="de"')
    expect(html).toContain('<title>Beam – Die Vertrauensschicht für KI-Agenten</title>')
    expect(html).toContain('<link rel="canonical" href="https://beam.directory/de" />')
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://beam.directory/" />')
    expect(html).toContain('<link rel="alternate" hreflang="de" href="https://beam.directory/de" />')
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://beam.directory/" />')
    expect(html).toContain('content="https://beam.directory/og-image-de.png"')
    expect(html).toContain('<meta property="og:locale" content="de_DE" />')
    expect(html).toContain('Grundsatz: Kein Agent darf mehr als sein Mensch.')
    expect(html).not.toContain('<title>x</title>')
  })

  it('renders English defaults and the start page variants', () => {
    expect(applyHeadToHtml(template, 'en', 'home')).toContain('content="https://beam.directory/og-image.png"')
    const start = headData('de', 'start')
    expect(start.canonical).toBe('https://beam.directory/de/start')
    expect(start.alternates).toContainEqual({ hreflang: 'en', href: 'https://beam.directory/start' })
    expect(renderHeadTags(headData('en', 'start'))).toContain('<title>Connect an agent – Beam</title>')
  })

  it('escapes HTML and lists one output file per locale and route', () => {
    expect(renderHeadTags(headData('en', 'home'))).not.toMatch(/content="[^"]*<[^"]*"/)
    expect(HTML_VARIANTS.map((variant) => variant.file).sort()).toEqual([
      'de/index.html',
      'de/start/index.html',
      'de/verify/index.html',
      'index.html',
      'start/index.html',
      'verify/index.html',
    ])
    expect(headData('en', 'verify').canonical).toBe('https://beam.directory/verify')
    expect(headData('de', 'verify').title).toBe('Ist dieser Agent echt? – Beam')
    expect(renderHeadTags(headData('de', 'verify'))).toContain('content="https://beam.directory/de/verify"')
  })

  it('fails loudly without markers', () => {
    expect(() => applyHeadToHtml('<html lang="en"><head></head></html>', 'de', 'home')).toThrow()
  })
})
