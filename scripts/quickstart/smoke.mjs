import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const cliEntry = path.join(repoRoot, 'packages/cli/dist/index.js')
const sdkEntry = path.join(repoRoot, 'packages/sdk-typescript/dist/index.js')
const envPath = path.join(repoRoot, 'ops/quickstart/.env')

function logStep(message) {
  console.log(`[quickstart] ${message}`)
}

async function ensureBuiltArtifacts() {
  for (const file of [cliEntry, sdkEntry]) {
    await access(file)
  }
}

function parseEnvFile(raw) {
  const env = {}
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    let value = trimmed.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

async function loadQuickstartEnv() {
  try {
    const raw = await readFile(envPath, 'utf8')
    return parseEnvFile(raw)
  } catch {
    return {}
  }
}

function resolveRuntime(config) {
  const directoryPort = config.DIRECTORY_PORT ?? process.env.DIRECTORY_PORT ?? '3100'
  const dashboardPort = config.DASHBOARD_PORT ?? process.env.DASHBOARD_PORT ?? '5173'
  const messageBusPort = config.MESSAGE_BUS_PORT ?? process.env.MESSAGE_BUS_PORT ?? '8420'
  const echoAgentPort = config.ECHO_AGENT_PORT ?? process.env.ECHO_AGENT_PORT ?? '8788'
  const adminEmailList = config.BEAM_ADMIN_EMAILS ?? process.env.BEAM_ADMIN_EMAILS ?? 'ops@beam.local'
  const [adminEmail = 'ops@beam.local'] = adminEmailList
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return {
    adminEmail,
    busApiKey: config.BEAM_BUS_API_KEY ?? process.env.BEAM_BUS_API_KEY ?? 'beam-local-bus-key',
    directoryUrl: `http://127.0.0.1:${directoryPort}`,
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
    messageBusUrl: `http://127.0.0.1:${messageBusPort}`,
    echoHealthUrl: `http://127.0.0.1:${echoAgentPort}/echo/health`,
  }
}

async function waitForHealth(url, label, predicate = (response) => response.ok) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (predicate(response)) {
        return response
      }
    } catch {
      // Wait until the service is up.
    }
    await sleep(500)
  }

  throw new Error(`${label} did not become ready at ${url}`)
}

async function requestJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  const payload = text.length > 0 ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }
  return payload
}

async function requestText(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }
  return text
}

async function runCli(args, cwd) {
  return execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      CI: '1',
    },
    maxBuffer: 1024 * 1024,
  })
}

async function main() {
  await ensureBuiltArtifacts()
  const config = await loadQuickstartEnv()
  const runtime = resolveRuntime(config)
  const cliRoot = await mkdtemp(path.join(tmpdir(), 'beam-quickstart-'))
  const message = `hello from quickstart ${Date.now()}`
  const agentName = `smoke-${Date.now().toString(36)}`

  try {
    logStep('waiting for the directory, dashboard, message bus, and echo agent')
    await waitForHealth(`${runtime.directoryUrl}/health`, 'directory')
    await waitForHealth(`${runtime.messageBusUrl}/health`, 'message bus')
    await waitForHealth(runtime.echoHealthUrl, 'echo agent')
    const dashboardResponse = await waitForHealth(`${runtime.dashboardUrl}/`, 'dashboard')
    const dashboardHtml = await dashboardResponse.text()
    assert.match(dashboardHtml, /Beam Dashboard/u, 'dashboard root did not return the dashboard HTML shell')

    logStep('requesting a local admin magic link')
    const authConfig = await requestJson(`${runtime.directoryUrl}/admin/auth/config`)
    assert.equal(authConfig.configured, true, 'directory admin auth is not configured')

    const challenge = await requestJson(`${runtime.directoryUrl}/admin/auth/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: runtime.dashboardUrl.replace('127.0.0.1', 'localhost') },
      body: JSON.stringify({ email: runtime.adminEmail }),
    })

    assert.equal(challenge.ok, true, 'admin magic-link challenge did not succeed')
    assert.equal(typeof challenge.token, 'string', 'local dev flow did not return a magic-link token')
    assert.match(challenge.url, /^http:\/\/localhost:\d+\/auth\/callback\?token=/u, 'magic-link callback URL did not target the local dashboard')

    logStep('verifying the admin session')
    const verify = await requestJson(`${runtime.directoryUrl}/admin/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: challenge.token }),
    })

    assert.equal(verify.ok, true, 'admin verify did not succeed')
    assert.equal(typeof verify.token, 'string', 'verify did not return an admin session token')

    const session = await requestJson(`${runtime.directoryUrl}/admin/auth/session`, {
      headers: {
        Authorization: `Bearer ${verify.token}`,
      },
    })

    assert.equal(session.email, runtime.adminEmail, 'admin session email did not round-trip')

    logStep('creating and registering a smoke-test sender with the CLI')
    await runCli(['init', '--agent', agentName, '--org', 'quickstart', '--directory', runtime.directoryUrl, '--force'], cliRoot)
    await runCli(['register', '--display-name', 'Quickstart Smoke Sender', '--capabilities', 'conversation.message', '--directory', runtime.directoryUrl], cliRoot)

    const identity = JSON.parse(await readFile(path.join(cliRoot, '.beam/identity.json'), 'utf8'))
    const senderBeamId = identity.identity.beamId
    assert.equal(typeof senderBeamId, 'string', 'smoke sender Beam ID could not be resolved')

    logStep('opening the echo ACL for the smoke-test sender')
    await requestJson(`${runtime.directoryUrl}/acl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${verify.token}`,
      },
      body: JSON.stringify({
        targetBeamId: 'echo@beam.directory',
        intentType: 'conversation.message',
        allowedFrom: senderBeamId,
      }),
    })

    logStep('verifying discovery through CLI lookup')
    const lookup = JSON.parse((await runCli(['lookup', 'echo@beam.directory', '--directory', runtime.directoryUrl, '--json'], cliRoot)).stdout)
    assert.equal(lookup.beamId, 'echo@beam.directory', 'CLI lookup did not resolve the echo agent')

    logStep('sending a conversation.message via beam talk')
    const reply = JSON.parse((await runCli(['talk', 'echo@beam.directory', message, '--directory', runtime.directoryUrl, '--timeout', '20', '--json'], cliRoot)).stdout)
    assert.equal(reply.message, `Echo: ${message}`, 'echo agent did not return the expected talk reply')

    logStep('checking the message-bus stats endpoint')
    const busStats = await requestJson(`${runtime.messageBusUrl}/v1/beam/stats`, {
      headers: {
        Authorization: `Bearer ${runtime.busApiKey}`,
      },
    })
    assert.equal(typeof busStats.total, 'number', 'message-bus stats did not return totals')

    console.log('')
    console.log('Hosted quickstart smoke passed.')
    console.log(`Admin email: ${runtime.adminEmail}`)
    console.log(`Smoke sender: ${senderBeamId}`)
    console.log(`Echo reply: ${reply.message}`)
  } finally {
    await rm(cliRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[quickstart] smoke failed:', error)
  process.exit(1)
})
