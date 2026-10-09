/**
 * Onboarding against a local directory built from this checkout.
 *
 *   node scripts/e2e/public-onboarding.mjs
 *
 * Starts a TXT DNS on 127.0.0.1:5353, the directory with that resolver, and a vite preview
 * of the public site pointed at the directory. Playwright walks company → person → agent →
 * connect in English and German. Screenshots land in /opt/cursor/artifacts/onboarding.
 *
 * Build the site first with VITE_DIRECTORY_API_URL set to this script's directory
 * (http://127.0.0.1:3191). Do not commit that build: a production build omits the variable
 * and calls https://api.beam.directory. The directory package must already be compiled.
 *
 * The well-known check is expected to fail: the directory will not fetch a loopback file.
 * KYC becomes "verified" only through the operator admin route, not through the website.
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { startTxtServer } from './onboarding-dns.mjs'

const root = resolve(import.meta.dirname, '../..')
const siteRoot = resolve(root, 'packages/public-site/site')
const directoryEntry = resolve(root, 'packages/directory/dist/index.js')
const dnsFile = resolve(root, 'output/onboarding-dns.json')
const artifactDir = '/opt/cursor/artifacts/onboarding'
const directoryPort = 3191
const sitePort = 4179
const directoryUrl = `http://127.0.0.1:${directoryPort}`
const siteUrl = `http://127.0.0.1:${sitePort}`
const adminEmail = 'operator@beam-e2e.test'

mkdirSync(resolve(root, 'output'), { recursive: true })
mkdirSync(artifactDir, { recursive: true })
writeFileSync(dnsFile, '{}\n')

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const issuerPrivate = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const issuerPublic = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

const children = []
function track(child) {
  children.push(child)
  return child
}

function waitFor(url, timeoutMs = 30_000) {
  const started = Date.now()
  return new Promise((resolveReady, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(url)
        if (response.ok || response.status < 500) {
          resolveReady()
          return
        }
      } catch {
        // server still booting
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`))
        return
      }
      setTimeout(tick, 250)
    }
    tick()
  })
}

const dns = await startTxtServer(dnsFile, 5353)
const directory = track(spawn(process.execPath, ['--import', resolve(import.meta.dirname, 'onboarding-dns-preload.mjs'), directoryEntry], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(directoryPort),
    DB_PATH: resolve(root, 'output/onboarding-e2e.sqlite'),
    JWT_SECRET: 'onboarding-e2e-jwt-secret',
    BEAM_ADMIN_EMAILS: adminEmail,
    BEAM_DIRECTORY_SIGNING_PRIVATE_KEY: issuerPrivate,
    BEAM_DIRECTORY_SIGNING_PUBLIC_KEY: issuerPublic,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
directory.stdout.on('data', (chunk) => process.stdout.write(`[directory] ${chunk}`))
directory.stderr.on('data', (chunk) => process.stderr.write(`[directory] ${chunk}`))

const preview = track(spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(sitePort), '--strictPort'], {
  cwd: siteRoot,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
preview.stdout.on('data', (chunk) => process.stdout.write(`[site] ${chunk}`))
preview.stderr.on('data', (chunk) => process.stderr.write(`[site] ${chunk}`))

const leaks = []
const failures = []

async function ensureTheme(page, theme) {
  const current = await page.evaluate(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  if (current === theme) return
  const label = await page.evaluate(() => document.documentElement.lang)
  const name = label === 'de' ? 'Hell- oder Dunkelmodus umschalten' : 'Toggle light or dark mode'
  await page.getByRole('button', { name }).click()
  await page.waitForFunction((expected) => document.documentElement.classList.contains(expected), theme)
}

async function shoot(page, locale, step) {
  const shots = [
    ['light', 'desktop', { width: 1280, height: 900 }],
    ['dark', 'desktop', { width: 1280, height: 900 }],
    ['dark', 'mobile', { width: 390, height: 844 }],
    ['light', 'mobile', { width: 390, height: 844 }],
  ]
  for (const [theme, viewport, size] of shots) {
    await page.setViewportSize(size)
    await ensureTheme(page, theme)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.waitForTimeout(150)
    const file = resolve(artifactDir, `${locale}-${theme}-${viewport}-${step}.png`)
    await page.screenshot({ path: file, fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await ensureTheme(page, 'light')
}

function watch(page) {
  page.on('request', (request) => {
    const body = request.postData() ?? ''
    if (/"privateKey"/.test(body) || body.includes('BEGIN PRIVATE')) leaks.push(request.url())
  })
  page.on('pageerror', (error) => failures.push(error.message))
}

async function markKycVerified(personId) {
  const link = await fetch(`${directoryUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
    body: JSON.stringify({ email: adminEmail }),
  })
  const issued = await link.json()
  if (!issued.token) throw new Error(`Admin magic link did not return a token: ${link.status} ${JSON.stringify(issued)}`)
  const session = await fetch(`${directoryUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
    body: JSON.stringify({ token: issued.token }),
  })
  const verified = await session.json()
  if (!verified.token) throw new Error(`Admin verify failed: ${session.status}`)
  const review = await fetch(`${directoryUrl}/admin/people/${personId}/kyc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${verified.token}` },
    body: JSON.stringify({ status: 'verified', note: 'e2e manual review' }),
  })
  if (!review.ok) throw new Error(`KYC review failed: ${review.status} ${await review.text()}`)
}

async function runFlow(page, locale) {
  const de = locale === 'de'
  const stamp = Date.now().toString(36)
  const label = `e2e${stamp}${de ? 'd' : 'e'}`
  const domain = `${label}.com`
  const company = de ? 'Beispiel GmbH' : 'Example Ltd'
  const personName = de ? 'Ada Beispiel' : 'Ada Example'
  const role = de ? 'Leitung Einkauf' : 'Head of purchasing'
  await page.goto(`${siteUrl}${de ? '/de/start' : '/start'}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    localStorage.setItem('theme', 'light')
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
  })

  const progress = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('beam.onboarding.progress.v1') ?? '{}'))
  const navCheck = async (where, nextCount, backCount) => {
    const next = await page.getByRole('button', { name: de ? /^Weiter/ : /^(Next|Continue)/ }).filter({ visible: true }).count()
    const back = await page.getByRole('button', { name: de ? 'Zurück' : 'Back' }).filter({ visible: true }).count()
    if (next !== nextCount || back !== backCount) {
      throw new Error(`${locale} ${where}: expected ${nextCount} next / ${backCount} back, got ${next} next / ${back} back`)
    }
  }
  const open = async (selector) => {
    const details = page.locator(selector)
    if (!(await details.evaluate((element) => element.open))) await details.locator('summary').first().click()
  }

  await page.getByTestId('path-company').click()
  await page.locator('#org-display-name').waitFor()
  await navCheck('company form', 1, 0)
  await page.locator('#org-display-name').fill(company)
  await page.locator('#org-domain').fill(domain)
  await page.locator('#claim-domain').click()
  await page.locator('#check-dns').waitFor()
  await page.getByText(de ? 'Firmenschlüssel sichern' : 'Save your company key').waitFor()
  await navCheck('company claimed', 0, 0)
  const record = await progress()
  if (!record.txtValue || !record.txtName) throw new Error(`No DNS challenge on the page: ${JSON.stringify(record)}`)
  if (!String(record.orgName).includes('--')) throw new Error(`Expected a stored claim name, got ${record.orgName}`)

  await open('#file-method')
  await page.locator('#check-file').click()
  await page.getByText(de ? 'Beam konnte die Datei auf deiner Website nicht abrufen' : 'Beam could not fetch the file on your site').waitFor({ timeout: 20_000 })
  if ((await progress()).orgVerified) throw new Error('Well-known check must not verify a domain Beam cannot fetch')

  writeFileSync(dnsFile, JSON.stringify({ [record.txtName]: record.txtValue }))
  await page.locator('#check-dns').click()
  await page.getByText(de ? 'Website bestätigt' : 'Website confirmed').first().waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('beam.onboarding.progress.v1') ?? '{}').orgVerified === true)
  const promoted = (await progress()).orgName
  if (promoted !== label) throw new Error(`Expected promotion to ${label}, got ${promoted}`)
  await navCheck('company verified', 1, 0)

  await open('#registry')
  await page.locator('#registry-number').fill('HRB 123456')
  await page.locator('#registry-court').fill('Amtsgericht Berlin (Charlottenburg)')
  await page.locator('#registry-legal-name').fill(company)
  await page.locator('#registry-applicant').fill(personName)
  await page.locator('#registry-role').selectOption('geschaeftsfuehrer')
  await page.locator('#submit-registry').click()
  await page.getByText(de ? 'Zur Prüfung eingereicht' : 'Submitted for review').first().waitFor()
  await page.getByText(de ? 'Vertretungsberechtigung' : 'Power of representation').waitFor({ state: 'attached' })
  await shoot(page, locale, 'firma')

  await page.locator('#next-step').click()
  await page.locator('#person-name').waitFor()
  await navCheck('person form', 0, 1)
  await page.locator('#person-name').fill(personName)
  await page.locator('#person-email').fill(`ada@${domain}`)
  await open('#person-advanced')
  await page.locator('#person-role').fill(role)
  await page.locator('#create-person').click()
  await page.getByText(de ? 'Beam prüft' : 'Beam is checking', { exact: true }).waitFor({ timeout: 20_000 })
  const person = await progress()
  if (!person.personId) throw new Error('Person id missing after create')
  if (person.personKycStatus !== 'pending') throw new Error(`Expected the manual review to be requested, got ${person.personKycStatus}`)
  if (person.personRole !== role) throw new Error(`Expected role ${role}, got ${person.personRole}`)
  await page.getByText(de ? 'Persönliche Schlüsseldatei sichern' : 'Save your personal key file').waitFor()
  await page.getByText(de ? 'Identität mit Ausweisdokument' : 'Identity with an ID document').waitFor({ state: 'attached' })
  await page.getByText(de ? 'Personio oder Microsoft Entra' : 'Personio or Microsoft Entra').waitFor({ state: 'attached' })

  if (!de) {
    await open('#person-advanced')
    await page.locator('#invite-email').fill(`sam@${domain}`)
    await page.locator('#invite-role').fill('Buyer')
    await page.locator('#invite-person').click()
    await page.getByText('Shown once').waitFor()
  }
  await shoot(page, locale, 'person')

  await markKycVerified(person.personId)
  await page.locator('#refresh-kyc').click()
  await page.getByText(de ? 'Geprüft' : 'Checked', { exact: true }).first().waitFor()
  await navCheck('person saved', 1, 1)

  await page.locator('#next-step').click()
  await page.locator('#agent-name').waitFor()
  await navCheck('agent form', 0, 1)
  await page.locator('#agent-name').fill('buyer')
  await open('#agent-advanced')
  await page.locator('#agent-display-name').fill(de ? 'Einkauf' : 'Purchasing')
  await page.locator('#register-agent').click()
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('beam.onboarding.progress.v1') ?? '{}').encryptionKeyPublished === true, undefined, { timeout: 20_000 })
  const agent = await progress()
  if (agent.registeredBeamId !== `buyer@${label}.beam.directory`) throw new Error(`Unexpected agent address ${agent.registeredBeamId}`)
  await page.getByText(de ? 'Agenten-Datei sichern' : 'Save your agent file').waitFor()
  await page.locator('#issue-mandate').click()
  await page.getByText(de ? 'Bestätigt. Dein Agent darf: lesen, Dateien senden' : 'Confirmed. Your agent may: read, send files').first().waitFor({ timeout: 20_000 })
  await open('#agent-advanced')
  await page.getByTestId('trust-assertion').waitFor()
  await navCheck('agent created', 1, 1)
  await shoot(page, locale, 'agent')

  await page.locator('#next-step').click()
  const checkLink = page.locator('#check-own-agent')
  await checkLink.waitFor()
  await navCheck('done', 0, 1)
  const checkHref = await checkLink.getAttribute('href')
  if (!checkHref?.includes(encodeURIComponent(agent.registeredBeamId))) throw new Error(`Unexpected check link ${checkHref}`)
  await open('#connect-assistant')
  await page.getByText(de ? 'Es einzuschalten braucht eine eigene Entscheidung' : 'Turning it on needs a separate decision').waitFor()
  await page.getByText(de ? 'Bald verfügbar' : 'Coming soon').first().waitFor()
  await shoot(page, locale, 'verbinden')

  const stored = await page.evaluate(() => sessionStorage.getItem('beam.onboarding.progress.v1') ?? '')
  if (stored.includes('beam_org_') || stored.includes('"privateKey"') || stored.includes('bk_')) {
    throw new Error('sessionStorage contains a secret')
  }
}

try {
  await waitFor(`${directoryUrl}/health`)
  await waitFor(siteUrl)
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  const page = await context.newPage()
  watch(page)
  await runFlow(page, 'en')
  await context.clearCookies()
  await page.evaluate(() => sessionStorage.clear())
  await runFlow(page, 'de')
  await browser.close()
  if (leaks.length > 0) throw new Error(`Private key left the browser: ${leaks.join(', ')}`)
  if (failures.length > 0) throw new Error(failures.join('\n'))
  console.log('public onboarding e2e passed')
} finally {
  dns.close()
  for (const child of children) child.kill('SIGKILL')
}
