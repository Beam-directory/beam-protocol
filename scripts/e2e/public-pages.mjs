import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const siteUrl = process.env.BEAM_CLAIM_SITE_URL ?? 'http://127.0.0.1:4175'
const outputDir = resolve('output/playwright/public-pages')
const pages = ['privacy.html', 'terms.html', 'status.html', 'register.html', 'hosted-beta.html', 'playground.html', 'guided-evaluation.html']
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const issues = []

try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    for (const pageName of pages) {
      const page = await context.newPage()
      const label = `${pageName}-${viewport.name}`
      page.on('console', (message) => { if (message.type() === 'error') issues.push(`${label} console: ${message.text()}`) })
      page.on('pageerror', (error) => issues.push(`${label} page: ${error.message}`))
      page.on('response', (response) => { if (response.status() >= 400) issues.push(`${label} ${response.status()}: ${response.url()}`) })
      const response = await page.goto(`${siteUrl}/${pageName}`, { waitUntil: 'networkidle' })
      assert.equal(response?.status(), 200, label)
      assert.ok((await page.title()).trim().length > 0, `${label} has no title`)
      assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth), true, `${label} overflows horizontally`)
      const height = await page.locator('html').evaluate((element) => element.scrollHeight)
      for (let top = 0; top < height; top += Math.max(300, viewport.height * .7)) {
        await page.evaluate((scrollTop) => window.scrollTo({ top: scrollTop, behavior: 'instant' }), top)
        await page.waitForTimeout(40)
      }
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await page.screenshot({ path: resolve(outputDir, `${pageName.replace('.html', '')}-${viewport.name}.png`), fullPage: true })
      await page.close()
    }
    await context.close()
  }
  assert.deepEqual(issues, [])
  console.log('Public Beam subpages passed desktop and mobile browser checks.')
} finally {
  await browser.close()
}
