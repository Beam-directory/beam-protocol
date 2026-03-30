import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const envPath = path.join(repoRoot, 'ops/quickstart/.env')

function logStep(message) {
  console.log(`[quickstart] ${message}`)
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
  const directoryPort = config.DIRECTORY_PORT ?? process.env.DIRECTORY_PORT ?? '43100'
  const dashboardPort = config.DASHBOARD_PORT ?? process.env.DASHBOARD_PORT ?? '43173'
  const messageBusPort = config.MESSAGE_BUS_PORT ?? process.env.MESSAGE_BUS_PORT ?? '43220'
  const demoAgentPort = config.DEMO_AGENT_PORT ?? process.env.DEMO_AGENT_PORT ?? '43290'
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
    messageBusBaseUrl: `http://127.0.0.1:${messageBusPort}`,
    messageBusUrl: `http://127.0.0.1:${messageBusPort}/v1/beam`,
    demoAgentUrl: `http://127.0.0.1:${demoAgentPort}`,
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

async function main() {
  const config = await loadQuickstartEnv()
  const runtime = resolveRuntime(config)
  logStep('waiting for the directory, dashboard, message bus, and hosted demo agents')
  await waitForHealth(`${runtime.directoryUrl}/health`, 'directory')
  await waitForHealth(`${runtime.messageBusBaseUrl}/health`, 'message bus')
  await waitForHealth(`${runtime.demoAgentUrl}/health`, 'hosted demo agents')
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

  logStep('reseeding the hosted partner handoff demo identities')
  const seed = await requestJson(`${runtime.demoAgentUrl}/demo/reseed`, {
    method: 'POST',
  })
  assert.equal(seed.agents.partnerDesk.beamId, 'partner-desk@northwind.beam.directory', 'demo identities were not seeded correctly')

  logStep('running the canonical hosted partner handoff')
  const run = await requestJson(`${runtime.demoAgentUrl}/demo/run`, {
    method: 'POST',
  })
  assert.equal(run.quote.totalPriceEur, 44160, 'quote total did not match the demo scenario')
  assert.equal(run.quote.supplier, 'partner-desk@northwind.beam.directory', 'quote supplier did not round-trip')
  assert.equal(run.asyncPreflight.financeReceived, true, 'finance preflight was not observed by the demo flow')
  assert.equal(run.asyncPreflight.acknowledgement, 'accepted', 'async acknowledgement did not match the expected semantics')

  logStep('checking the quote trace through the admin observability API')
  const quoteTrace = await requestJson(`${runtime.directoryUrl}/observability/intents/${encodeURIComponent(run.quote.nonce)}`, {
    headers: {
      Authorization: `Bearer ${verify.token}`,
    },
  })
  assert.equal(quoteTrace.intent.status, 'acked', 'quote trace did not finish in acked state')
  assert(quoteTrace.stages.some((stage) => stage.stage === 'dispatched'), 'quote trace did not include dispatch')

  logStep('checking the message-bus stats endpoint')
  const busStats = await requestJson(`${runtime.messageBusUrl}/stats`, {
    headers: {
      Authorization: `Bearer ${runtime.busApiKey}`,
    },
  })
  assert.equal(typeof busStats.total, 'number', 'message-bus stats did not return totals')

  console.log('')
  console.log('Hosted quickstart smoke passed.')
  console.log(`Admin email: ${runtime.adminEmail}`)
  console.log(`Quote nonce: ${run.quote.nonce}`)
  console.log(`Async preflight: ${run.asyncPreflight.messageBusStatus}`)
}

main().catch((error) => {
  console.error('[quickstart] smoke failed:', error)
  process.exit(1)
})
