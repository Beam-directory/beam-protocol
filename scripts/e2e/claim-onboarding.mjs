import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const siteUrl = process.env.BEAM_CLAIM_SITE_URL ?? 'http://127.0.0.1:4175'
const outputDir = resolve('output/playwright')
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const browserIssues = []

function watch(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') browserIssues.push(`${label} console: ${message.text()}`)
  })
  page.on('pageerror', (error) => browserIssues.push(`${label} page: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 400) browserIssues.push(`${label} ${response.status()}: ${response.url()}`)
  })
}

async function revealFullPage(page) {
  const metrics = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
  }))
  for (let top = 0; top < metrics.height; top += Math.max(300, metrics.viewport * .72)) {
    await page.evaluate((scrollTop) => window.scrollTo({ top: scrollTop, behavior: 'instant' }), top)
    await page.waitForTimeout(60)
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.waitForTimeout(100)
}

try {
  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  })
  const page = await desktopContext.newPage()
  watch(page, 'desktop')

  await page.goto(siteUrl, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: /claim your beam/i }).waitFor()
  await revealFullPage(page)
  assert.equal(await page.locator('.reveal').evaluateAll((elements) => elements.every((element) => element.classList.contains('is-visible'))), true)
  await page.screenshot({ path: resolve(outputDir, 'beam-home-desktop.png'), fullPage: true })

  const primaryClaim = page.getByRole('link', { name: /claim your beam/i }).first()
  assert.equal(await primaryClaim.getAttribute('href'), '/claim')
  await primaryClaim.click()
  await page.getByRole('heading', { name: /choose your beam id/i }).waitFor()

  const handle = `beamcheck${Date.now().toString().slice(-8)}`
  await page.getByLabel('Name').fill('Beam Browser Check')
  await page.getByLabel('Beam ID').fill(handle)
  await page.getByLabel('Email address').fill('browser-check@example.com')

  const claimResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/identity-claims')
    && response.request().method() === 'POST'
  ))
  await page.getByRole('button', { name: 'Continue' }).click()
  const claimResponse = await claimResponsePromise
  assert.equal(claimResponse.status(), 202)
  const claimResult = await claimResponse.json()
  assert.match(claimResult.claimUrl, /\/claim#token=/)
  await page.getByRole('heading', { name: /your beam is waiting/i }).waitFor()

  const claimPage = await desktopContext.newPage()
  watch(claimPage, 'claim')
  await claimPage.goto(claimResult.claimUrl, { waitUntil: 'networkidle' })
  await claimPage.getByRole('heading', { name: /this beam is ready for you/i }).waitFor()
  assert.equal(await claimPage.locator('#confirmed-beam-id').textContent(), `${handle}@beam.directory`)

  await claimPage.getByRole('button', { name: /create my beam/i }).click()
  await claimPage.getByRole('heading', { name: /welcome to beam/i }).waitFor()
  const downloadPromise = claimPage.waitForEvent('download')
  await claimPage.getByRole('button', { name: /export recovery kit/i }).click()
  const download = await downloadPromise
  assert.match(download.suggestedFilename(), /-recovery\.json$/)
  assert.equal(await claimPage.locator('#claimed-beam-id').textContent(), `${handle}@beam.directory`)
  await claimPage.waitForTimeout(650)
  await claimPage.screenshot({ path: resolve(outputDir, 'beam-claim-complete.png'), fullPage: true })
  await desktopContext.close()

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const mobile = await mobileContext.newPage()
  watch(mobile, 'mobile')
  await mobile.goto(siteUrl, { waitUntil: 'networkidle' })
  await mobile.getByRole('heading', { name: /claim your beam/i }).waitFor()
  await revealFullPage(mobile)
  assert.equal(await mobile.locator('.reveal').evaluateAll((elements) => elements.every((element) => element.classList.contains('is-visible'))), true)
  await mobile.screenshot({ path: resolve(outputDir, 'beam-home-mobile.png'), fullPage: true })
  assert.equal(await mobile.locator('body').evaluate((element) => element.scrollWidth <= window.innerWidth), true)

  await mobile.goto(`${siteUrl}/claim`, { waitUntil: 'networkidle' })
  await mobile.getByRole('heading', { name: /choose your beam id/i }).waitFor()
  await mobile.screenshot({ path: resolve(outputDir, 'beam-claim-mobile.png'), fullPage: true })
  assert.equal(await mobile.locator('body').evaluate((element) => element.scrollWidth <= window.innerWidth), true)
  await mobileContext.close()

  assert.deepEqual(browserIssues, [])
  console.log('Claim onboarding browser check passed on desktop and mobile.')
} finally {
  await browser.close()
}
