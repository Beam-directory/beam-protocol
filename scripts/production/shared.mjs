import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

export const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
export const repoPackageVersion = (() => {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const directoryEntry = path.join(repoRoot, 'packages/directory/dist/index.js')
const messageBusEntry = path.join(repoRoot, 'packages/message-bus/dist/server.js')
const directoryDbModule = path.join(repoRoot, 'packages/directory/dist/db.js')
const messageBusDbModule = path.join(repoRoot, 'packages/message-bus/dist/db.js')

export function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }
  return process.argv[index + 1] ?? fallback
}

export function optionalFlag(name, fallback = null) {
  const value = readFlag(name, fallback)
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.startsWith('--')) {
    return fallback
  }

  return trimmed
}

export function resolveReleaseLabel(fallback = repoPackageVersion) {
  const label = optionalFlag('--release', fallback)
  if (typeof label === 'string' && label.trim().length > 0) {
    return label.trim()
  }
  return fallback
}

export async function ensureBuiltArtifacts() {
  for (const file of [directoryEntry, messageBusEntry, directoryDbModule, messageBusDbModule]) {
    await access(file)
  }
}

export async function loadDirectoryDbModule() {
  return import(pathToFileURL(directoryDbModule).href)
}

export async function loadMessageBusDbModule() {
  return import(pathToFileURL(messageBusDbModule).href)
}

export async function getFreePort() {
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

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

export function spawnProcess({ name, command, args, env, cwd = repoRoot }) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      CI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`)
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`)
  })

  return child
}

export async function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) {
    return
  }

  child.kill(signal)
  const exitPromise = once(child, 'exit').catch(() => undefined)
  await Promise.race([exitPromise, sleep(5_000)])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => undefined)
  }
}

export async function waitForHealth(url, label, predicate = (response) => response.ok, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (predicate(response)) {
        return response
      }
    } catch {
      // Wait until the service is ready.
    }
    await sleep(250)
  }

  throw new Error(`${label} did not become healthy at ${url}`)
}

export async function requestJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let payload = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch (error) {
      throw new Error(`Request to ${url} returned non-JSON content: ${text.slice(0, 240)}`, { cause: error })
    }
  }
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }
  return payload
}

export async function requestText(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }
  return {
    text,
    response,
  }
}

export async function createAdminToken(directoryUrl, adminEmail = 'ops@beam.local') {
  const challenge = await requestJson(`${directoryUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:5173',
    },
    body: JSON.stringify({ email: adminEmail }),
  })

  const verify = await requestJson(`${directoryUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challenge.token }),
  })

  return verify.token
}

export function createAdminHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function fileSha256(filePath) {
  const buffer = await readFile(filePath)
  return sha256(buffer)
}

export async function writeMarkdownReport(reportPath, markdown) {
  await writeFile(reportPath, markdown.trimEnd() + '\n', 'utf8')
}

export function toJsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

export function formatDate(value = new Date()) {
  return value.toISOString().slice(0, 10)
}

export function formatDateTime(value = new Date()) {
  return value.toISOString()
}

export async function startProductionHarness(options = {}) {
  await ensureBuiltArtifacts()

  const directoryPort = await getFreePort()
  const messageBusPort = options.withMessageBus === false ? null : await getFreePort()
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'beam-production-'))
  const directoryDbPath = path.join(tempRoot, 'beam-directory.sqlite')
  const messageBusDbPath = messageBusPort == null ? null : path.join(tempRoot, 'beam-message-bus.sqlite')
  const directoryUrl = `http://127.0.0.1:${directoryPort}`
  const messageBusBaseUrl = messageBusPort == null ? null : `http://127.0.0.1:${messageBusPort}`
  const messageBusUrl = messageBusBaseUrl == null ? null : `${messageBusBaseUrl}/v1/beam`
  const adminEmail = options.adminEmail ?? 'ops@beam.local'
  const busApiKey = options.busApiKey ?? 'beam-production-bus-key'
  const jwtSecret = options.jwtSecret ?? 'beam-production-secret'

  const directoryDbApi = await loadDirectoryDbModule()
  const directoryDb = directoryDbApi.createDatabase(directoryDbPath)
  if (options.seed?.directory) {
    await options.seed.directory(directoryDb, directoryDbApi)
  }
  directoryDb.close()

  if (messageBusDbPath != null) {
    const messageBusDbApi = await loadMessageBusDbModule()
    const messageBusDb = messageBusDbApi.initDatabase(messageBusDbPath)
    if (options.seed?.messageBus) {
      await options.seed.messageBus(messageBusDb, messageBusDbApi)
    }
    messageBusDb.close()
  }

  let directoryProcess = null
  let messageBusProcess = null

  async function startServices() {
    directoryProcess = spawnProcess({
      name: 'directory',
      command: process.execPath,
      args: [directoryEntry],
      env: {
        PORT: String(directoryPort),
        DB_PATH: directoryDbPath,
        JWT_SECRET: jwtSecret,
        BEAM_ADMIN_EMAILS: adminEmail,
        BEAM_OPERATOR_EMAILS: options.operatorEmails ?? '',
        BEAM_VIEWER_EMAILS: options.viewerEmails ?? '',
        BEAM_DIRECTORY_URL: directoryUrl,
        PUBLIC_BASE_URL: directoryUrl,
      },
    })
    await waitForHealth(`${directoryUrl}/health`, 'directory')

    if (messageBusDbPath != null && messageBusBaseUrl != null) {
      messageBusProcess = spawnProcess({
        name: 'message-bus',
        command: process.execPath,
        args: [
          messageBusEntry,
          '--port', String(messageBusPort),
          '--directory', directoryUrl,
          '--db', messageBusDbPath,
          '--rate-limit', '50',
        ],
        env: {
          BEAM_BUS_API_KEY: busApiKey,
          BEAM_BUS_STATS_PUBLIC: 'true',
        },
      })
      await waitForHealth(`${messageBusBaseUrl}/health`, 'message bus')
    }
  }

  async function stopServices() {
    await stopProcess(messageBusProcess)
    await stopProcess(directoryProcess)
    messageBusProcess = null
    directoryProcess = null
  }

  async function restartServices() {
    await stopServices()
    await startServices()
  }

  async function cleanup() {
    await stopServices()
    await rm(tempRoot, { recursive: true, force: true })
  }

  await startServices()

  return {
    repoRoot,
    tempRoot,
    directoryUrl,
    messageBusBaseUrl,
    messageBusUrl,
    directoryDbPath,
    messageBusDbPath,
    adminEmail,
    busApiKey,
    createAdminToken: () => createAdminToken(directoryUrl, adminEmail),
    startServices,
    stopServices,
    restartServices,
    cleanup,
  }
}

export function seedProofAgents(db, directoryDbApi) {
  directoryDbApi.registerAgent(db, {
    beamId: 'procurement@acme.beam.directory',
    displayName: 'Acme Procurement',
    capabilities: ['conversation.message'],
    publicKey: 'MCowBQYDK2VwAyEAEHzHjWwTn/RZiC407+hCtk8nde/GEVUn85iOaZBH2Bw=',
    verificationTier: 'business',
    email: 'procurement@acme.example',
    emailVerified: true,
  })
  directoryDbApi.registerAgent(db, {
    beamId: 'finance@northwind.beam.directory',
    displayName: 'Northwind Finance',
    capabilities: ['conversation.message'],
    publicKey: 'MCowBQYDK2VwAyEAr+N7jwgoTnwP/02HeC88JezBI3D/FbtcWbhOOyUpM8Y=',
    verificationTier: 'verified',
    email: 'finance@northwind.example',
    emailVerified: true,
  })
}

export function seedAckedIntent(db, directoryDbApi, nonce, timestamp, latencyMs = 220) {
  directoryDbApi.logIntentStart(db, {
    v: '1',
    nonce,
    from: 'procurement@acme.beam.directory',
    to: 'finance@northwind.beam.directory',
    intent: 'conversation.message',
    payload: { message: 'Can you approve the async quote?' },
    timestamp,
  })
  directoryDbApi.appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'received',
    timestamp,
    details: { channel: 'websocket' },
  })
  directoryDbApi.setIntentLifecycleStatus(db, { nonce, status: 'validated' })
  directoryDbApi.appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'validated',
    timestamp: '2026-03-31T10:15:31.000Z',
    details: { signatureVerified: true },
  })
  directoryDbApi.setIntentLifecycleStatus(db, { nonce, status: 'queued' })
  directoryDbApi.appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'queued',
    timestamp: '2026-03-31T10:15:32.000Z',
    details: { queue: 'default' },
  })
  directoryDbApi.setIntentLifecycleStatus(db, { nonce, status: 'dispatched' })
  directoryDbApi.appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'dispatched',
    timestamp: '2026-03-31T10:15:33.000Z',
    details: { transport: 'direct-http' },
  })
  directoryDbApi.setIntentLifecycleStatus(db, { nonce, status: 'delivered' })
  directoryDbApi.appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'delivered',
    timestamp: '2026-03-31T10:15:34.000Z',
    details: { route: 'direct-http' },
  })
  directoryDbApi.finalizeIntentLog(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    status: 'acked',
    latencyMs,
    resultJson: JSON.stringify({ success: true }),
  })
  directoryDbApi.appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'acked',
    timestamp: '2026-03-31T10:15:35.000Z',
    details: { route: 'direct-http' },
  })
}

export function seedFailedIntent(db, directoryDbApi, nonce, timestamp, latencyMs = 6_200) {
  directoryDbApi.logIntentStart(db, {
    v: '1',
    nonce,
    from: 'procurement@acme.beam.directory',
    to: 'finance@northwind.beam.directory',
    intent: 'conversation.message',
    payload: { message: 'Approve purchase order 1042.' },
    timestamp,
  })
  directoryDbApi.appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'received',
    timestamp,
  })
  directoryDbApi.setIntentLifecycleStatus(db, { nonce, status: 'validated' })
  directoryDbApi.appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'validated',
    timestamp,
  })
  directoryDbApi.finalizeIntentLog(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    status: 'failed',
    latencyMs,
    errorCode: 'TIMEOUT',
    resultJson: JSON.stringify({ success: false, error: 'Timed out waiting for partner approval.' }),
  })
}
