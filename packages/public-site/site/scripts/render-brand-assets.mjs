/**
 * Renders the Open Graph images and favicon PNGs reproducibly with Playwright (repo root node_modules).
 *
 *   node scripts/render-brand-assets.mjs
 *
 * Outputs:
 * - ../og-image.png      1200×630, English  (referenced by the EN head and by legacy pages)
 * - ../og-image-de.png   1200×630, German
 * - public/favicon-32.png, public/apple-touch-icon.png (from public/favicon.svg)
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.resolve(siteRoot, '..')
const require = createRequire(import.meta.url)
const fontPath = require.resolve('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2')
const font = (await readFile(fontPath)).toString('base64')
const markSvg = await readFile(path.join(siteRoot, 'public/favicon.svg'), 'utf8')

const COPY = {
  en: {
    lead: 'The trust layer for',
    accent: 'AI agents.',
    line: 'Signed messages from verified companies. Chats end-to-end encrypted.',
    file: 'og-image.png',
  },
  de: {
    lead: 'Die Vertrauensschicht für',
    accent: 'KI‑Agenten.',
    line: 'Signierte Nachrichten von geprüften Firmen. Chats Ende-zu-Ende verschlüsselt.',
    file: 'og-image-de.png',
  },
}

function ogHtml({ lead, accent, line }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face { font-family: Geist; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 900; }
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body { background: #0b0c10; color: #f4f5f8; font-family: Geist, sans-serif; position: relative; overflow: hidden; }
  .grid { position: absolute; inset: 0;
    background-image: linear-gradient(to right, rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.06) 1px, transparent 1px);
    background-size: 56px 56px; -webkit-mask-image: radial-gradient(ellipse 75% 70% at 30% 20%, #000 30%, transparent 78%); }
  .glow { position: absolute; inset: 0; filter: blur(30px);
    background: radial-gradient(38% 55% at 22% 18%, rgba(84,110,255,.42), transparent 70%), radial-gradient(34% 48% at 78% 28%, rgba(34,197,222,.26), transparent 70%); }
  .content { position: absolute; inset: 72px 80px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 30px; font-weight: 600; letter-spacing: -0.02em; }
  .brand svg { width: 52px; height: 52px; }
  h1 { margin-top: auto; font-size: 84px; line-height: 1.02; font-weight: 600; letter-spacing: -0.045em; max-width: 1000px; }
  h1, p { text-wrap: balance; }
  .accent { white-space: nowrap; background: linear-gradient(100deg, #6d84ff 10%, #4fd6ec 90%); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { margin-top: 28px; font-size: 30px; line-height: 1.35; color: #b7bcc9; max-width: 1000px; letter-spacing: -0.01em; }
  .footer { margin-top: 44px; display: flex; align-items: center; justify-content: space-between; font-size: 24px; color: #8d93a3; }
  .domain { color: #f4f5f8; font-weight: 500; }
  .line { position: absolute; left: 80px; right: 80px; bottom: 150px; height: 1px; background: linear-gradient(90deg, rgba(109,132,255,0), rgba(109,132,255,.6), rgba(79,214,236,0)); }
</style></head>
<body>
  <div class="glow"></div><div class="grid"></div>
  <div class="content">
    <div class="brand">${markSvg}<span>Beam</span></div>
    <h1>${lead} <span class="accent">${accent}</span></h1>
    <p>${line}</p>
    <div class="footer"><span class="domain">beam.directory</span><span>Grok · Claude · OpenAI · MCP</span></div>
  </div>
</body></html>`
}

function iconHtml(size) {
  return `<!doctype html><html><head><style>*{margin:0}html,body{width:${size}px;height:${size}px;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style></head><body>${markSvg}</body></html>`
}

const browser = await chromium.launch()
try {
  for (const copy of Object.values(COPY)) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
    await page.setContent(ogHtml(copy), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    await writeFile(path.join(packageRoot, copy.file), await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } }))
    await page.close()
    console.log('wrote', copy.file)
  }
  for (const [file, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    await page.setContent(iconHtml(size))
    await writeFile(path.join(siteRoot, 'public', file), await page.screenshot({ type: 'png', omitBackground: file === 'favicon-32.png' }))
    await page.close()
    console.log('wrote public/' + file)
  }
} finally {
  await browser.close()
}
