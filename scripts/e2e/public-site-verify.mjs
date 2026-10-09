/**
 * Playwright check of the public trust page against a local directory.
 *
 * Builds the site into a temporary directory with the local issuer key pinned,
 * so the published site files stay on the production directory key.
 *
 *   npm run test:public-site-verify
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
import { chromium } from 'playwright'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const siteRoot = path.join(repoRoot, 'packages/public-site/site')
const directoryEntry = path.join(repoRoot, 'packages/directory/dist/index.js')

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine an open TCP port'))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

function agentKey() {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

async function seed(dbPath) {
  const { createDatabase, createOrg, markOrgVerified, registerAgent } = await import('../../packages/directory/dist/db.js')
  const { insertPerson, setAgentResponsiblePerson } = await import('../../packages/directory/dist/trust/person-store.js')
  const { insertMandate } = await import('../../packages/directory/dist/trust/mandate-store.js')
  const db = createDatabase(dbPath)
  try {
    createOrg(db, {
      name: 'coppen',
      displayName: 'coppen',
      domain: 'coppen.de',
      apiKeyHash: 'public-site-verify-org',
      verificationToken: 'public-site-verify-token',
    })
    markOrgVerified(db, 'coppen', 'dns')
    const publicKey = agentKey()
    registerAgent(db, {
      beamId: 'jarvis@coppen.beam.directory',
      displayName: 'Jarvis',
      capabilities: ['conversation.message'],
      publicKey,
      org: 'coppen',
      visibility: 'public',
    })
    const person = insertPerson(db, {
      orgName: 'coppen',
      email: 'owner@coppen.de',
      displayName: 'Owner',
      role: 'owner',
      supervisorPersonId: null,
      publicKey: null,
      rights: { actions: ['read', 'file.send'], file: { maxBytes: 1_000_000 } },
    })
    db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id = ?`).run(person.id)
    setAgentResponsiblePerson(db, 'jarvis@coppen.beam.directory', person.id)
    insertMandate(db, {
      jti: 'public-site-verify-jarvis',
      personId: person.id,
      agentBeamId: 'jarvis@coppen.beam.directory',
      orgName: 'coppen',
      scopes: { actions: ['read', 'file.send'], file: { maxBytes: 1_000_000 } },
      expiresAt: '2027-10-08T00:00:00.000Z',
      escalationPersonId: null,
      signature: 'seed-signature',
      payloadHash: 'public-site-verify-jarvis-hash',
    })
  } finally {
    db.close()
  }
}

function startDirectory(dbPath, port, publicKey, privateKey) {
  const child = spawn(process.execPath, [directoryEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'public-site-verify-jwt',
      BEAM_DIRECTORY_SIGNING_PUBLIC_KEY: publicKey,
      BEAM_DIRECTORY_SIGNING_PRIVATE_KEY: privateKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout?.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr?.on('data', (chunk) => { logs += chunk.toString() })
  child.logs = () => logs
  return child
}

async function waitFor(url, label) {
  const deadline = Date.now() + 30_000
  let last = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.status === 200) return
      last = `${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed'
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`${label} did not become ready (${last})`)
}

const viteBin = path.join(repoRoot, 'node_modules/vite/bin/vite.js')

function run(args, options) {
  const child = spawn(process.execPath, [viteBin, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout?.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr?.on('data', (chunk) => { logs += chunk.toString() })
  child.logs = () => logs
  return child
}

const issuer = generateKeyPairSync('ed25519')
const pinnedPublicKey = issuer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const pinnedPrivateKey = issuer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const work = await mkdtemp(path.join(tmpdir(), 'beam-public-verify-'))
const dbPath = path.join(work, 'directory.db')
const outDir = path.join(work, 'site')
const directoryPort = await freePort()
const previewPort = await freePort()
const directoryUrl = `http://127.0.0.1:${directoryPort}`
const previewUrl = `http://127.0.0.1:${previewPort}`

let directory
let preview
let browser
let failed = false
try {
  await seed(dbPath)
  directory = startDirectory(dbPath, directoryPort, pinnedPublicKey, pinnedPrivateKey)
  await waitFor(`${directoryUrl}/agents/${encodeURIComponent('jarvis@coppen.beam.directory')}/trust-assertion`, 'directory')

  const build = run(['build', '--outDir', outDir], {
    cwd: siteRoot,
    env: {
      ...process.env,
      VITE_DIRECTORY_API_URL: directoryUrl,
      VITE_DIRECTORY_SIGNING_PUBLIC_KEY: pinnedPublicKey,
    },
  })
  const buildExit = await once(build, 'exit')
  if (buildExit[0] !== 0) {
    throw new Error(`vite build failed\n${build.logs()}`)
  }

  preview = run(['preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort', '--outDir', outDir], {
    cwd: siteRoot,
  })
  await waitFor(`${previewUrl}/verify`, 'preview')

  browser = await chromium.launch()
  const page = await browser.newPage()
  const yesEn = 'Yes, this agent belongs to coppen (coppen.de) and may: read, send files'
  const noEn = 'No, this agent is not verified – be careful.'
  const openDetails = async () => {
    const details = page.getByTestId('agent-check-details')
    if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click()
  }

  await page.goto(`${previewUrl}/verify?agent=${encodeURIComponent('jarvis@coppen.beam.directory')}`)
  await page.getByTestId('agent-check-headline').waitFor({ timeout: 20_000 })
  const verified = await page.getByTestId('agent-check-headline').innerText()
  if (verified !== yesEn) throw new Error(`expected "${yesEn}", got ${verified}`)
  const plain = await page.getByTestId('agent-check-status').innerText()
  if (!plain.includes('On behalf of: owner')) throw new Error(`expected the person line, got ${plain}`)
  if (plain.includes('Signature valid')) throw new Error('technical details should start collapsed')
  await openDetails()
  const org = await page.getByTestId('agent-check-org').innerText()
  if (!org.includes('coppen') || !org.includes('coppen.de')) throw new Error(`expected coppen in org card, got ${org}`)
  const signature = await page.getByTestId('agent-check-signature').innerText()
  if (!signature.includes('Signature valid')) throw new Error(`expected a valid signature, got ${signature}`)
  const title = await page.title()
  if (title !== 'Is this agent real? – Beam') throw new Error(`unexpected title ${title}`)

  await page.getByTestId('agent-check-tamper').click()
  await page.getByTestId('agent-check-headline').filter({ hasText: noEn }).waitFor({ timeout: 20_000 })
  const tampered = await page.getByTestId('agent-check-signature').innerText()
  if (!tampered.includes('one byte was changed')) throw new Error(`expected a tampered signature, got ${tampered}`)

  await page.goto(`${previewUrl}/verify?agent=${encodeURIComponent('fake-support@beam.directory')}`)
  await page.getByTestId('agent-check-headline').waitFor({ timeout: 20_000 })
  const exampleHeadline = await page.getByTestId('agent-check-headline').innerText()
  if (exampleHeadline !== noEn) throw new Error(`expected "${noEn}" for the example, got ${exampleHeadline}`)
  const exampleStatus = await page.getByTestId('agent-check-status').innerText()
  if (!exampleStatus.includes('Beam has no entry for this address.')) throw new Error(`expected not found for the example, got ${exampleStatus}`)
  await openDetails()
  const exampleDetails = await page.getByTestId('agent-check-details').innerText()
  if (!exampleDetails.includes('NOT verified')) throw new Error(`expected the untrusted line, got ${exampleDetails}`)

  await page.goto(`${previewUrl}/verify?agent=${encodeURIComponent('missing@coppen.beam.directory')}`)
  await page.getByTestId('agent-check-headline').waitFor({ timeout: 20_000 })
  const missing = await page.getByTestId('agent-check-status').innerText()
  if (!missing.includes('Beam has no entry for this address.')) throw new Error(`expected not found, got ${missing}`)

  const yesDe = 'Ja, dieser Agent gehört zu coppen (coppen.de) und darf: lesen, Dateien senden'
  await page.goto(`${previewUrl}/de/verify?agent=${encodeURIComponent('jarvis@coppen.beam.directory')}`)
  await page.getByTestId('agent-check-headline').waitFor({ timeout: 20_000 })
  const german = await page.getByTestId('agent-check-headline').innerText()
  if (german !== yesDe) throw new Error(`expected "${yesDe}", got ${german}`)

  await page.goto(`${previewUrl}/`)
  await page.getByTestId('agent-check').waitFor()
  await page.getByRole('button', { name: 'fake-support@beam.directory' }).waitFor()
  await page.getByRole('button', { name: 'jarvis@coppen.beam.directory' }).click()
  await page.getByTestId('agent-check-headline').filter({ hasText: yesEn }).waitFor({ timeout: 20_000 })

  await page.goto(`${previewUrl}/verify?agent=${encodeURIComponent('jarvis@coppen.beam.directory')}`)
  await page.getByRole('link', { name: 'Deutsch' }).click()
  await page.waitForURL(/\/de\/verify\?agent=jarvis%40coppen\.beam\.directory/)
  await page.getByTestId('agent-check-headline').filter({ hasText: yesDe }).waitFor({ timeout: 20_000 })

  console.log('public site trust check passed')
} catch (error) {
  if (directory?.logs) console.error(directory.logs())
  if (preview?.logs) console.error(preview.logs())
  console.error(error)
  failed = true
} finally {
  await Promise.race([
    browser?.close().catch(() => {}) ?? Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  await stopChild(preview)
  await stopChild(directory)
  await rm(work, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = once(child, 'exit')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
  await exited
  clearTimeout(timer)
}
