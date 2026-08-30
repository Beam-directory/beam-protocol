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

async function claimIdentity(context, input) {
  const claim = await context.newPage()
  watch(claim, `${input.label}-claim`)
  await claim.goto(`${siteUrl}/claim`, { waitUntil: 'networkidle' })
  await claim.getByLabel('Name').fill(input.displayName)
  await claim.getByLabel('Beam ID').fill(input.handle)
  await claim.getByLabel('Email address').fill(input.email)
  const reservationPromise = claim.waitForResponse((response) => response.url().endsWith('/identity-claims') && response.request().method() === 'POST')
  await claim.getByRole('button', { name: 'Continue' }).click()
  const reservation = await reservationPromise
  assert.equal(reservation.status(), 202)
  const reserved = await reservation.json()

  const confirmation = await context.newPage()
  watch(confirmation, `${input.label}-confirmation`)
  await claim.close()
  await confirmation.goto(reserved.claimUrl, { waitUntil: 'networkidle' })
  try {
    await confirmation.getByRole('heading', { name: /this beam is ready for you/i }).waitFor()
  } catch (error) {
    console.error(`${input.label} claim debug`, reserved.claimUrl, await confirmation.locator('body').innerText(), browserIssues)
    throw error
  }
  await confirmation.getByRole('button', { name: /create my beam/i }).click()
  await confirmation.getByRole('heading', { name: /welcome to beam/i }).waitFor()
  const downloadPromise = confirmation.waitForEvent('download')
  await confirmation.getByRole('button', { name: /export recovery kit/i }).click()
  const download = await downloadPromise
  const recoveryPath = resolve(outputDir, `${input.label}-network-v2-recovery.json`)
  await download.saveAs(recoveryPath)

  const popupPromise = context.waitForEvent('page')
  await confirmation.getByRole('button', { name: /open my beam/i }).click()
  const network = await popupPromise
  watch(network, `${input.label}-network`)
  try {
    await network.locator('#network-app:not([hidden])').waitFor()
  } catch (error) {
    console.error(`${input.label} network debug`, await network.locator('body').innerText(), browserIssues)
    throw error
  }
  await network.getByRole('heading', { name: 'Inbox' }).waitFor()
  await network.getByText(input.displayName, { exact: true }).waitFor()
  return { network, beamId: reserved.beamId, recoveryPath }
}

try {
  const suffix = Date.now().toString().slice(-8)
  const firstContext = await browser.newContext({ viewport: { width: 1500, height: 980 }, acceptDownloads: true })
  const secondContext = await browser.newContext({ viewport: { width: 1500, height: 980 }, acceptDownloads: true })
  const first = await claimIdentity(firstContext, {
    label: 'mira', displayName: 'Mira Network', handle: `mira${suffix}`, email: `mira-${suffix}@example.com`,
  })
  const second = await claimIdentity(secondContext, {
    label: 'noah', displayName: 'Noah Network', handle: `noah${suffix}`, email: `noah-${suffix}@example.com`,
  })

  await first.network.getByRole('button', { name: /contacts/i }).click()
  await first.network.locator('#search-query').fill(second.beamId)
  const [discoverResponse] = await Promise.all([
    first.network.waitForResponse((response) => response.url().includes('/network/discover')),
    first.network.getByRole('button', { name: 'Find', exact: true }).click(),
  ])
  assert.equal(discoverResponse.status(), 200)
  await first.network.locator('#search-list').getByText(second.beamId, { exact: true }).waitFor()
  const [connectionResponse] = await Promise.all([
    first.network.waitForResponse((response) => response.url().endsWith('/network/connections') && response.request().method() === 'POST'),
    first.network.locator('#search-list').getByRole('button', { name: 'Connect' }).click(),
  ])
  assert.equal(connectionResponse.status(), 201)

  await second.network.getByRole('button', { name: /requests/i }).click()
  await second.network.locator('#inbound-list').getByText(first.beamId, { exact: true }).waitFor()
  const [acceptResponse] = await Promise.all([
    second.network.waitForResponse((response) => response.url().endsWith('/respond')),
    second.network.locator('#inbound-list').getByRole('button', { name: 'Accept' }).click(),
  ])
  assert.equal(acceptResponse.status(), 200)

  await first.network.getByRole('button', { name: /contacts/i }).click()
  await first.network.locator('#connections-list').getByText(second.beamId, { exact: true }).waitFor()
  const [directResponse] = await Promise.all([
    first.network.waitForResponse((response) => response.url().endsWith('/network/conversations/direct')),
    first.network.locator('#connections-list').getByRole('button', { name: 'Message' }).click(),
  ])
  assert.ok([200, 201].includes(directResponse.status()))
  await first.network.locator('#conversation-active:not([hidden])').waitFor()
  await first.network.locator('#message-input').fill('Hello Noah — signed through Beam.')
  const [textMessageResponse] = await Promise.all([
    first.network.waitForResponse((response) => response.url().includes('/messages') && response.request().method() === 'POST'),
    first.network.locator('#message-form .send-button').click(),
  ])
  assert.equal(textMessageResponse.status(), 201)
  await first.network.locator('#message-stream').getByText('Hello Noah — signed through Beam.', { exact: true }).waitFor()

  await second.network.getByRole('button', { name: /messages/i }).click()
  await second.network.locator('.conversation-item').filter({ hasText: 'Mira Network' }).waitFor()
  await second.network.locator('.conversation-item').filter({ hasText: 'Mira Network' }).click()
  await second.network.locator('#message-stream').getByText('Hello Noah — signed through Beam.', { exact: true }).waitFor()

  await first.network.locator('#attachment-input').setInputFiles({
    name: 'beam-proof.txt', mimeType: 'text/plain', buffer: Buffer.from('Beam attachment proof'),
  })
  await first.network.locator('#attachment-preview:not([hidden])').waitFor()
  const [attachmentResponse] = await Promise.all([
    first.network.waitForResponse((response) => response.url().includes('/messages') && response.request().method() === 'POST'),
    first.network.locator('#message-form .send-button').click(),
  ])
  assert.equal(attachmentResponse.status(), 201)
  await second.network.getByText('beam-proof.txt', { exact: true }).waitFor()

  await first.network.locator('#new-group').click()
  await first.network.locator('#group-name').fill('COPPEN Agent Team')
  await first.network.locator('#group-contact-list input').check()
  const [groupResponse] = await Promise.all([
    first.network.waitForResponse((response) => response.url().endsWith('/network/groups')),
    first.network.locator('#create-group').click(),
  ])
  assert.equal(groupResponse.status(), 201)
  await first.network.getByText('COPPEN Agent Team', { exact: true }).first().waitFor()
  await first.network.locator('#message-input').fill('Clara and Noah — this is our verified agent room.')
  const [groupMessageResponse] = await Promise.all([
    first.network.waitForResponse((response) => response.url().includes('/messages') && response.request().method() === 'POST'),
    first.network.locator('#message-form .send-button').click(),
  ])
  assert.equal(groupMessageResponse.status(), 201)
  await first.network.locator('#message-stream').getByText('Clara and Noah — this is our verified agent room.', { exact: true }).waitFor()
  await second.network.getByRole('button', { name: /messages/i }).click()
  await second.network.locator('.conversation-item').filter({ hasText: 'COPPEN Agent Team' }).waitFor()

  await first.network.screenshot({ path: resolve(outputDir, 'beam-network-v2-desktop.png'), fullPage: true })
  assert.equal(await first.network.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth), true)

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const mobile = await mobileContext.newPage()
  watch(mobile, 'mobile-network')
  await mobile.goto(`${siteUrl}/network`, { waitUntil: 'networkidle' })
  await mobile.locator('#kit-input').setInputFiles(first.recoveryPath)
  try {
    await mobile.locator('#network-app:not([hidden])').waitFor()
  } catch (error) {
    console.error('mobile network debug', await mobile.locator('body').innerText(), browserIssues)
    throw error
  }
  await mobile.locator('.conversation-item').first().click()
  await mobile.locator('#conversation-active:not([hidden])').waitFor()
  await mobile.locator('#toast').waitFor({ state: 'hidden' })
  assert.equal(await mobile.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth), true)
  await mobile.screenshot({ path: resolve(outputDir, 'beam-network-v2-mobile.png'), fullPage: true })
  await first.network.waitForFunction(() => document.querySelectorAll('#device-list .device-row').length >= 2)
  const devices = await first.network.locator('#device-list .device-row').count()
  assert.ok(devices >= 2)

  await mobileContext.close()
  await firstContext.close()
  await secondContext.close()
  assert.deepEqual(browserIssues, [])
  console.log('Beam Network v2 messaging, groups, attachments, presence, and multi-device UI passed.')
} finally {
  await browser.close()
}
