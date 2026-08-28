import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const siteUrl = process.env.BEAM_CLAIM_SITE_URL ?? 'http://localhost:4175'
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

async function claimIdentity(context, input) {
  const claim = await context.newPage()
  watch(claim, `${input.label}-claim`)
  await claim.goto(`${siteUrl}/claim.html`, { waitUntil: 'networkidle' })
  await claim.getByLabel('Your name').fill(input.displayName)
  await claim.getByLabel('Your Beam name').fill(input.handle)
  await claim.getByLabel('Email').fill(input.email)

  const reservationPromise = claim.waitForResponse((response) => (
    response.url().endsWith('/identity-claims') && response.request().method() === 'POST'
  ))
  await claim.getByRole('button', { name: 'Continue' }).click()
  const reservation = await reservationPromise
  assert.equal(reservation.status(), 202)
  const reserved = await reservation.json()

  const confirmation = await context.newPage()
  watch(confirmation, `${input.label}-confirmation`)
  await claim.close()
  await confirmation.goto(reserved.claimUrl, { waitUntil: 'networkidle' })
  await confirmation.getByRole('heading', { name: /this beam is ready for you/i }).waitFor()

  const downloadPromise = confirmation.waitForEvent('download')
  await confirmation.getByRole('button', { name: /create my beam/i }).click()
  const download = await downloadPromise
  const recoveryPath = resolve(outputDir, `${input.label}-network-recovery.json`)
  await download.saveAs(recoveryPath)
  await confirmation.getByRole('heading', { name: /welcome to beam/i }).waitFor()

  const popupPromise = context.waitForEvent('page')
  await confirmation.getByRole('button', { name: /open my beam/i }).click()
  const network = await popupPromise
  watch(network, `${input.label}-network`)
  await network.getByRole('heading', { name: /your network/i }).waitFor()
  await network.waitForLoadState('networkidle')
  assert.equal(await network.locator('#header-beam-id').textContent(), reserved.beamId)

  return { claim: confirmation, network, beamId: reserved.beamId, recoveryPath }
}

try {
  const suffix = Date.now().toString().slice(-9)
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  const first = await claimIdentity(context, {
    label: 'first',
    displayName: 'Mira Network',
    handle: `mira${suffix}`,
    email: `mira-${suffix}@example.com`,
  })
  const second = await claimIdentity(context, {
    label: 'second',
    displayName: 'Noah Network',
    handle: `noah${suffix}`,
    email: `noah-${suffix}@example.com`,
  })

  const webAuthn = await context.newCDPSession(first.network)
  await webAuthn.send('WebAuthn.enable')
  await webAuthn.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      hasHmacSecret: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })

  await first.network.locator('#enable-device-vault').click()
  await first.network.waitForFunction(() => document.getElementById('device-vault-action')?.textContent === 'Forget this device')
  const storedVault = await first.network.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('beam-device-vault', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('vaults', 'readonly')
      const get = transaction.objectStore('vaults').get('primary')
      get.onerror = () => reject(get.error)
      get.onsuccess = () => {
        resolve(get.result)
        database.close()
      }
    }
  }))
  assert.equal(storedVault.beamId, first.beamId)
  assert.equal(typeof storedVault.ciphertext, 'string')
  assert.equal(JSON.stringify(storedVault).includes('privateKey'), false)
  assert.equal(JSON.stringify(storedVault).includes('bk_'), false)

  await first.network.locator('#identity-menu').click()
  await first.network.locator('#device-unlock').waitFor()
  await first.network.screenshot({ path: resolve(outputDir, 'beam-network-passkey-unlock.png'), fullPage: true })
  const reopenPromise = first.network.waitForResponse((response) => response.url().endsWith('/network/me'))
  await first.network.locator('#device-unlock').click()
  assert.equal((await reopenPromise).status(), 200)
  await first.network.getByRole('heading', { name: /your network/i }).waitFor()
  await first.network.locator('[data-view="profile"]').click()
  await first.network.screenshot({ path: resolve(outputDir, 'beam-network-passkey-profile.png'), fullPage: true })
  await first.network.locator('[data-view="contacts"]').click()

  await first.network.locator('#search-query').fill(second.beamId)
  const discoverPromise = first.network.waitForResponse((response) => response.url().includes('/network/discover'))
  await first.network.getByRole('button', { name: /^find/i }).click()
  assert.equal((await discoverPromise).status(), 200)
  await first.network.locator('#search-list').getByText(second.beamId, { exact: true }).waitFor()

  const [requestResponse] = await Promise.all([
    first.network.waitForResponse((response) => (
      response.url().endsWith('/network/connections') && response.request().method() === 'POST'
    )),
    first.network.getByRole('button', { name: 'Connect', exact: true }).click(),
  ])
  assert.equal(requestResponse.status(), 201)
  await first.network.getByText('REQUEST SENT', { exact: true }).waitFor()

  await second.network.locator('[data-refresh]').click()
  await second.network.locator('[data-view="requests"]').click()
  await second.network.getByText(first.beamId, { exact: true }).waitFor()
  await second.network.screenshot({ path: resolve(outputDir, 'beam-network-request.png'), fullPage: true })
  const [acceptResponse] = await Promise.all([
    second.network.waitForResponse((response) => response.url().endsWith('/respond')),
    second.network.getByRole('button', { name: 'Accept' }).click(),
  ])
  assert.equal(acceptResponse.status(), 200)

  await first.network.locator('[data-refresh]').click()
  await first.network.locator('#connections-list').getByText(second.beamId, { exact: true }).waitFor()
  assert.equal(await first.network.locator('#stat-contacts').textContent(), '1')
  await first.network.screenshot({ path: resolve(outputDir, 'beam-network-desktop.png'), fullPage: true })

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const mobile = await mobileContext.newPage()
  watch(mobile, 'mobile-network')
  await mobile.goto(`${siteUrl}/network.html`, { waitUntil: 'networkidle' })
  await mobile.getByRole('heading', { name: /open your beam/i }).waitFor()
  await mobile.screenshot({ path: resolve(outputDir, 'beam-network-unlock-mobile.png'), fullPage: true })
  await mobile.locator('#kit-input').setInputFiles(first.recoveryPath)
  await mobile.getByRole('heading', { name: /your network/i }).waitFor()
  await mobile.locator('#connections-list').getByText(second.beamId, { exact: true }).waitFor()
  assert.equal(await mobile.locator('body').evaluate((element) => element.scrollWidth <= window.innerWidth), true)
  await mobile.screenshot({ path: resolve(outputDir, 'beam-network-mobile.png'), fullPage: true })

  await mobileContext.close()
  await context.close()
  assert.deepEqual(browserIssues, [])
  console.log('Beam network onboarding and mutual connection passed on desktop and mobile.')
} finally {
  await browser.close()
}
