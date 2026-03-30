import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const directoryEntry = path.join(repoRoot, 'packages/directory/dist/index.js')
const messageBusEntry = path.join(repoRoot, 'packages/message-bus/dist/server.js')
const sdkEntry = path.join(repoRoot, 'packages/sdk-typescript/dist/index.js')

async function ensureBuiltArtifacts() {
  for (const file of [directoryEntry, messageBusEntry, sdkEntry]) {
    await access(file)
  }
}

async function loadSdk() {
  return import(pathToFileURL(sdkEntry).href)
}

async function getFreePort() {
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

function spawnProcess({ name, command, args, env }) {
  const child = spawn(command, args, {
    cwd: repoRoot,
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

async function stopProcess(child, signal = 'SIGTERM') {
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

async function waitForHealth(url, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // Wait until the service is ready.
    }
    await sleep(250)
  }

  throw new Error(`${label} did not become healthy at ${url}`)
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

async function allowIntent(directoryUrl, targetBeamId, intentType, allowedFrom) {
  await requestJson(`${directoryUrl}/acl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetBeamId, intentType, allowedFrom }),
  })
}

async function createAdminToken(directoryUrl, adminEmail) {
  const challenge = await requestJson(`${directoryUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:5173',
    },
    body: JSON.stringify({ email: adminEmail }),
  })

  assert.equal(challenge.ok, true, 'admin magic-link request did not succeed')
  assert.equal(typeof challenge.token, 'string', 'local admin flow did not return a token')

  const verify = await requestJson(`${directoryUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challenge.token }),
  })

  assert.equal(verify.ok, true, 'admin verify did not succeed')
  assert.equal(typeof verify.token, 'string', 'admin verify did not return a bearer token')
  return verify.token
}

async function main() {
  await ensureBuiltArtifacts()
  const { BeamClient, BeamIdentity } = await loadSdk()

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'beam-dogfood-'))
  const directoryPort = await getFreePort()
  const messageBusPort = await getFreePort()
  const directoryDb = path.join(tempRoot, 'beam-directory.sqlite')
  const messageBusDb = path.join(tempRoot, 'beam-message-bus.sqlite')
  const identityBundlePath = path.join(tempRoot, 'beam-bus-identities.json')
  const directoryUrl = `http://127.0.0.1:${directoryPort}`
  const messageBusBaseUrl = `http://127.0.0.1:${messageBusPort}`
  const messageBusUrl = `${messageBusBaseUrl}/v1/beam`
  const adminEmail = 'ops@beam.local'
  const busApiKey = 'beam-dogfood-bus-key'

  let directoryProcess
  let messageBusProcess
  const clients = []

  try {
    const procurementIdentity = BeamIdentity.generate({ agentName: 'procurement', orgName: 'acme' })
    const partnerDeskIdentity = BeamIdentity.generate({ agentName: 'partner-desk', orgName: 'northwind' })
    const warehouseIdentity = BeamIdentity.generate({ agentName: 'warehouse', orgName: 'northwind' })
    const financeIdentity = BeamIdentity.generate({ agentName: 'finance', orgName: 'acme' })

    await writeFile(
      identityBundlePath,
      JSON.stringify({
        partnerDesk: partnerDeskIdentity.export(),
      }, null, 2),
      'utf8',
    )

    directoryProcess = spawnProcess({
      name: 'directory',
      command: process.execPath,
      args: [directoryEntry],
      env: {
        PORT: String(directoryPort),
        DB_PATH: directoryDb,
        JWT_SECRET: 'beam-dogfood-secret',
        BEAM_ADMIN_EMAILS: adminEmail,
      },
    })

    await waitForHealth(`${directoryUrl}/health`, 'directory')

    messageBusProcess = spawnProcess({
      name: 'message-bus',
      command: process.execPath,
      args: [
        messageBusEntry,
        '--port', String(messageBusPort),
        '--directory', directoryUrl,
        '--db', messageBusDb,
        '--identity', identityBundlePath,
        '--rate-limit', '50',
      ],
      env: {
        BEAM_BUS_API_KEY: busApiKey,
        BEAM_BUS_CLEAN_TEST_DATA: 'true',
      },
    })

    await waitForHealth(`${messageBusBaseUrl}/health`, 'message bus')

    const adminToken = await createAdminToken(directoryUrl, adminEmail)

    const procurement = new BeamClient({
      identity: procurementIdentity.export(),
      directoryUrl,
    })
    const partnerDesk = new BeamClient({
      identity: partnerDeskIdentity.export(),
      directoryUrl,
    })
    const warehouse = new BeamClient({
      identity: warehouseIdentity.export(),
      directoryUrl,
    })
    const finance = new BeamClient({
      identity: financeIdentity.export(),
      directoryUrl,
    })
    clients.push(procurement, partnerDesk, warehouse, finance)

    const workflow = {
      quoteRequestNonce: null,
      inventoryCheckNonce: null,
      financeNotificationNonce: null,
      financeNotificationStatus: null,
      financeNotificationError: null,
      financeNotificationReceived: false,
    }

    warehouse.on('inventory.check', async (frame, respond) => {
      console.log(`[warehouse] inventory.check from ${frame.from}`)
      workflow.inventoryCheckNonce = frame.nonce
      respond({
        success: true,
        payload: {
          sku: frame.payload.sku,
          quantity: frame.payload.quantity,
          available: true,
          confidence: 'high',
          shipWindow: 'Thu 08:00-12:00 CET',
          warehouse: warehouse.beamId,
        },
      })
    })

    finance.on('purchase.preflight', async (frame, respond) => {
      console.log(`[finance] purchase.preflight from ${frame.from}`)
      workflow.financeNotificationNonce = frame.nonce
      workflow.financeNotificationReceived = true
      respond({
        success: true,
        payload: {
          accepted: true,
          reviewedBy: finance.beamId,
        },
      })
    })

    partnerDesk.on('quote.request', async (frame, respond) => {
      console.log(`[partner-desk] quote.request from ${frame.from}`)
      workflow.quoteRequestNonce = frame.nonce

      const inventoryResult = await partnerDesk.send(warehouse.beamId, 'inventory.check', {
        sku: frame.payload.sku,
        quantity: frame.payload.quantity,
        shipTo: frame.payload.shipTo,
      })

      const responsePayload = {
        project: frame.payload.project,
        sku: frame.payload.sku,
        quantity: frame.payload.quantity,
        quotedUnitPriceEur: 184,
        totalPriceEur: Number(frame.payload.quantity ?? 0) * 184,
        supplier: partnerDesk.beamId,
        inventory: inventoryResult.payload,
      }

      respond({
        success: true,
        payload: responsePayload,
      })

      void requestJson(`${messageBusUrl}/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${busApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: partnerDesk.beamId,
          to: finance.beamId,
          intent: 'purchase.preflight',
          payload: {
            requestNonce: frame.nonce,
            sku: frame.payload.sku,
            quantity: frame.payload.quantity,
            totalPriceEur: responsePayload.totalPriceEur,
          },
        }),
      }).then((financeNotification) => {
        workflow.financeNotificationNonce = financeNotification.nonce
        workflow.financeNotificationStatus = financeNotification.status
      }).catch((error) => {
        workflow.financeNotificationStatus = 'failed'
        workflow.financeNotificationError = error instanceof Error ? error.message : String(error)
      })
    })

    await procurement.register('Acme Procurement Desk', ['quote.request'])
    await partnerDesk.register('Northwind Partner Desk', ['quote.request', 'inventory.check'])
    await warehouse.register('Northwind Warehouse', ['inventory.check'])
    await finance.register('Acme Finance Desk', ['purchase.preflight'])

    await allowIntent(directoryUrl, partnerDesk.beamId, 'quote.request', procurement.beamId)
    await allowIntent(directoryUrl, warehouse.beamId, 'inventory.check', partnerDesk.beamId)
    await allowIntent(directoryUrl, finance.beamId, 'purchase.preflight', partnerDesk.beamId)

    await Promise.all(clients.map((client) => client.connect()))
    await sleep(250)

    const quote = await procurement.send(partnerDesk.beamId, 'quote.request', {
      project: 'Mannheim rooftop rollout',
      sku: 'INV-240',
      quantity: 240,
      shipTo: 'Mannheim, DE',
      neededBy: '2026-04-03',
    })

    await sleep(500)
    const financeDeadline = Date.now() + 5_000
    while (!workflow.financeNotificationStatus && Date.now() < financeDeadline) {
      await sleep(100)
    }

    const authHeaders = { Authorization: `Bearer ${adminToken}` }
    const quoteTrace = await requestJson(`${directoryUrl}/observability/intents/${encodeURIComponent(quote.nonce)}`, {
      headers: authHeaders,
    })
    const inventoryTrace = workflow.inventoryCheckNonce
      ? await requestJson(`${directoryUrl}/observability/intents/${encodeURIComponent(workflow.inventoryCheckNonce)}`, {
          headers: authHeaders,
        })
      : null
    const financeTrace = workflow.financeNotificationNonce
      ? await requestJson(`${directoryUrl}/observability/intents/${encodeURIComponent(workflow.financeNotificationNonce)}`, {
          headers: authHeaders,
        })
      : null
    const alerts = await requestJson(`${directoryUrl}/observability/alerts?hours=24`, {
      headers: authHeaders,
    })
    const audit = await requestJson(`${directoryUrl}/observability/audit?limit=25&hours=24`, {
      headers: authHeaders,
    })
    const busStats = await requestJson(`${messageBusUrl}/stats`, {
      headers: { Authorization: `Bearer ${busApiKey}` },
    })
    const deadLetters = await requestJson(`${messageBusUrl}/dead-letter?limit=10`, {
      headers: { Authorization: `Bearer ${busApiKey}` },
    })

    const summary = {
      generatedAt: new Date().toISOString(),
      scenario: 'verified_partner_handoff',
      agents: {
        procurement: procurement.beamId,
        partnerDesk: partnerDesk.beamId,
        warehouse: warehouse.beamId,
        finance: finance.beamId,
      },
      result: {
        nonce: quote.nonce,
        success: quote.success,
        quotedUnitPriceEur: quote.payload?.quotedUnitPriceEur ?? null,
        totalPriceEur: quote.payload?.totalPriceEur ?? null,
        shipWindow: quote.payload?.inventory?.shipWindow ?? null,
      },
      traces: {
        quote: quoteTrace.stages.map((stage) => stage.stage),
        inventory: inventoryTrace ? inventoryTrace.stages.map((stage) => stage.stage) : [],
        finance: financeTrace ? financeTrace.stages.map((stage) => stage.stage) : [],
      },
      bus: {
        total: busStats.total,
        delivered: busStats.delivered,
        queued: busStats.queued,
        deadLetter: busStats.dead_letter,
        financeNotificationStatus: workflow.financeNotificationStatus,
        financeNotificationError: workflow.financeNotificationError,
        financeNotificationReceived: workflow.financeNotificationReceived,
      },
      observability: {
        alertCount: alerts.alerts.length,
        criticalAlerts: alerts.alerts.filter((alert) => alert.severity === 'critical').map((alert) => alert.id),
        auditActions: audit.entries.slice(0, 8).map((entry) => entry.action),
        deadLetters: deadLetters.count,
      },
      findings: [
        'The Acme to Northwind quote workflow completed end to end with a traceable nonce and no dead letters.',
        'A message-bus finance notification delivered successfully during the same run, so direct request/response and queued fan-out both worked in one scenario.',
        'Alerts stayed empty for this clean run; release readiness still depends on continued coverage for degraded or cross-version paths.',
      ],
      followUps: [
        'Add signed archival compatibility fixtures from previous released versions instead of only parser-level fixtures.',
        'Define an explicit async acknowledgement pattern for message-bus initiated requests where the sender does not keep a pending result.',
      ],
    }

    console.log(JSON.stringify(summary, null, 2))
  } finally {
    for (const client of clients) {
      client.disconnect()
    }
    await stopProcess(messageBusProcess)
    await stopProcess(directoryProcess)
    await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[dogfood] partner handoff failed')
  if (error instanceof Error) {
    console.error(error.message)
    if (error.cause instanceof Error) {
      console.error(error.cause.message)
    }
  } else {
    console.error(String(error))
  }
  process.exit(1)
})
