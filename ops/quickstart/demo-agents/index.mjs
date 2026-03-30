import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { BeamClient } from 'beam-protocol-sdk'

const directoryUrl = (process.env.BEAM_DIRECTORY_URL ?? 'http://directory:3100').replace(/\/$/, '')
const busUrl = (process.env.BEAM_BUS_URL ?? 'http://message-bus:8420/v1/beam').replace(/\/$/, '')
const busBaseUrl = busUrl.replace(/\/v1\/beam$/, '')
const busApiKey = process.env.BEAM_BUS_API_KEY ?? ''
const identityPath = process.env.DEMO_IDENTITY_PATH ?? '/app/demo-identities.json'
const port = Number.parseInt(process.env.PORT ?? '8790', 10)

const DEMO_SPECS = {
  procurement: {
    key: 'procurement',
    displayName: 'Acme Procurement Desk',
    capabilities: ['quote.request'],
  },
  partnerDesk: {
    key: 'partnerDesk',
    displayName: 'Northwind Partner Desk',
    capabilities: ['quote.request', 'inventory.check'],
  },
  warehouse: {
    key: 'warehouse',
    displayName: 'Northwind Warehouse',
    capabilities: ['inventory.check'],
  },
  finance: {
    key: 'finance',
    displayName: 'Acme Finance Desk',
    capabilities: ['purchase.preflight'],
  },
}

const state = {
  seeded: false,
  seededAt: null,
  lastRun: null,
  lastError: null,
}

const asyncNotifications = new Map()
let identities = null
let clients = null
let handlersAttached = false
let seedPromise = null

async function waitForHealth(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // Wait until the dependency is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
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

async function loadIdentityBundle() {
  const raw = await readFile(identityPath, 'utf8')
  const parsed = JSON.parse(raw)
  return {
    procurement: parsed.procurement,
    partnerDesk: parsed.partnerDesk,
    warehouse: parsed.warehouse,
    finance: parsed.finance,
  }
}

function createClients(bundle) {
  return {
    procurement: new BeamClient({ identity: bundle.procurement, directoryUrl }),
    partnerDesk: new BeamClient({ identity: bundle.partnerDesk, directoryUrl }),
    warehouse: new BeamClient({ identity: bundle.warehouse, directoryUrl }),
    finance: new BeamClient({ identity: bundle.finance, directoryUrl }),
  }
}

function buildSeedSummary() {
  return {
    scenario: 'verified_partner_handoff',
    seeded: state.seeded,
    seededAt: state.seededAt,
    agents: {
      procurement: {
        beamId: identities?.procurement.beamId ?? null,
        displayName: DEMO_SPECS.procurement.displayName,
      },
      partnerDesk: {
        beamId: identities?.partnerDesk.beamId ?? null,
        displayName: DEMO_SPECS.partnerDesk.displayName,
      },
      warehouse: {
        beamId: identities?.warehouse.beamId ?? null,
        displayName: DEMO_SPECS.warehouse.displayName,
      },
      finance: {
        beamId: identities?.finance.beamId ?? null,
        displayName: DEMO_SPECS.finance.displayName,
      },
    },
  }
}

async function allowIntent(targetBeamId, intentType, allowedFrom) {
  await requestJson(`${directoryUrl}/acl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetBeamId, intentType, allowedFrom }),
  })
}

async function sendFinancePreflight(requestNonce, sku, quantity, totalPriceEur) {
  const existing = asyncNotifications.get(requestNonce) ?? { requestNonce }
  asyncNotifications.set(requestNonce, existing)

  try {
    const response = await requestJson(`${busUrl}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${busApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: clients.partnerDesk.beamId,
        to: clients.finance.beamId,
        intent: 'purchase.preflight',
        payload: {
          requestNonce,
          sku,
          quantity,
          totalPriceEur,
        },
      }),
    })

    existing.notificationNonce = response.nonce ?? existing.notificationNonce ?? null
    existing.messageBusStatus = response.status ?? null
    existing.error = response.error ?? null
  } catch (error) {
    existing.messageBusStatus = 'failed'
    existing.error = error instanceof Error ? error.message : String(error)
  }
}

function attachHandlers() {
  if (!clients || handlersAttached) {
    return
  }

  clients.warehouse.on('inventory.check', async (frame, respond) => {
    const quantity = Number(frame.payload.quantity ?? 0)
    respond({
      success: true,
      payload: {
        sku: frame.payload.sku,
        quantity,
        available: quantity <= 240,
        confidence: 'high',
        shipWindow: 'Thu 08:00-12:00 CET',
        warehouse: clients.warehouse.beamId,
      },
    })
  })

  clients.finance.on('purchase.preflight', async (frame, respond) => {
    const requestNonce = typeof frame.payload.requestNonce === 'string' ? frame.payload.requestNonce : frame.nonce
    const record = asyncNotifications.get(requestNonce) ?? { requestNonce }
    record.financeReceived = true
    record.notificationNonce = frame.nonce
    record.acknowledgement = 'accepted'
    record.terminal = false
    record.reviewedBy = clients.finance.beamId
    asyncNotifications.set(requestNonce, record)

    respond({
      success: true,
      payload: {
        accepted: true,
        acknowledgement: 'accepted',
        terminal: false,
        reviewedBy: clients.finance.beamId,
        nextAction: 'approval.pending',
      },
    })
  })

  clients.partnerDesk.on('quote.request', async (frame, respond) => {
    const record = asyncNotifications.get(frame.nonce) ?? { requestNonce: frame.nonce }
    asyncNotifications.set(frame.nonce, record)

    const inventoryResult = await clients.partnerDesk.send(clients.warehouse.beamId, 'inventory.check', {
      sku: frame.payload.sku,
      quantity: frame.payload.quantity,
      shipTo: frame.payload.shipTo,
    })

    record.inventoryNonce = inventoryResult.nonce

    const responsePayload = {
      project: frame.payload.project,
      sku: frame.payload.sku,
      quantity: frame.payload.quantity,
      quotedUnitPriceEur: 184,
      totalPriceEur: Number(frame.payload.quantity ?? 0) * 184,
      supplier: clients.partnerDesk.beamId,
      inventory: inventoryResult.payload,
    }

    respond({
      success: true,
      payload: responsePayload,
    })

    void sendFinancePreflight(
      frame.nonce,
      String(frame.payload.sku ?? ''),
      Number(frame.payload.quantity ?? 0),
      responsePayload.totalPriceEur,
    )
  })

  handlersAttached = true
}

async function ensureRegistered(client, spec) {
  const existing = await client.directory.lookup(client.beamId)
  const expectedPublicKey = identities?.[spec.key]?.publicKeyBase64 ?? null
  const expectedCapabilities = [...spec.capabilities].sort()
  const existingCapabilities = [...(existing?.capabilities ?? [])].sort()

  if (
    existing
    && existing.displayName === spec.displayName
    && existing.publicKey === expectedPublicKey
    && existingCapabilities.length === expectedCapabilities.length
    && existingCapabilities.every((capability, index) => capability === expectedCapabilities[index])
  ) {
    return existing
  }

  return client.register(spec.displayName, spec.capabilities)
}

async function seedDemo() {
  if (seedPromise) {
    return seedPromise
  }

  seedPromise = (async () => {
    await waitForHealth(`${directoryUrl}/health`, 'directory')
    await waitForHealth(`${busBaseUrl}/health`, 'message bus')

    if (!identities) {
      identities = await loadIdentityBundle()
    }
    if (!clients) {
      clients = createClients(identities)
    }

    attachHandlers()

    await ensureRegistered(clients.procurement, DEMO_SPECS.procurement)
    await ensureRegistered(clients.partnerDesk, DEMO_SPECS.partnerDesk)
    await ensureRegistered(clients.warehouse, DEMO_SPECS.warehouse)
    await ensureRegistered(clients.finance, DEMO_SPECS.finance)

    await allowIntent(clients.partnerDesk.beamId, 'quote.request', clients.procurement.beamId)
    await allowIntent(clients.warehouse.beamId, 'inventory.check', clients.partnerDesk.beamId)
    await allowIntent(clients.finance.beamId, 'purchase.preflight', clients.partnerDesk.beamId)

    await clients.partnerDesk.connect()
    await clients.warehouse.connect()
    await clients.finance.connect()

    state.seeded = true
    state.seededAt = new Date().toISOString()
    state.lastError = null
    return buildSeedSummary()
  })()

  try {
    return await seedPromise
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    seedPromise = null
  }
}

async function runScenario() {
  await seedDemo()

  const requestPayload = {
    project: 'Mannheim rooftop rollout',
    sku: 'INV-240',
    quantity: 240,
    shipTo: 'Mannheim, DE',
    neededBy: '2026-04-03',
  }

  const quote = await clients.procurement.send(clients.partnerDesk.beamId, 'quote.request', requestPayload)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const record = asyncNotifications.get(quote.nonce)
    if (record?.messageBusStatus || record?.financeReceived) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const asyncPreflight = asyncNotifications.get(quote.nonce) ?? { requestNonce: quote.nonce }
  const summary = {
    scenario: 'verified_partner_handoff',
    generatedAt: new Date().toISOString(),
    request: requestPayload,
    agents: buildSeedSummary().agents,
    quote: {
      nonce: quote.nonce,
      success: quote.success,
      quotedUnitPriceEur: quote.payload?.quotedUnitPriceEur ?? null,
      totalPriceEur: quote.payload?.totalPriceEur ?? null,
      shipWindow: quote.payload?.inventory?.shipWindow ?? null,
      supplier: quote.payload?.supplier ?? null,
    },
    inventory: {
      nonce: asyncPreflight.inventoryNonce ?? null,
    },
    asyncPreflight: {
      requestNonce: quote.nonce,
      notificationNonce: asyncPreflight.notificationNonce ?? null,
      messageBusStatus: asyncPreflight.messageBusStatus ?? null,
      financeReceived: asyncPreflight.financeReceived ?? false,
      acknowledgement: asyncPreflight.acknowledgement ?? null,
      terminal: asyncPreflight.terminal ?? null,
      reviewedBy: asyncPreflight.reviewedBy ?? null,
      error: asyncPreflight.error ?? null,
    },
  }

  state.lastRun = summary
  return summary
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    writeJson(res, 400, { error: 'missing_url' })
    return
  }

  const url = new URL(req.url, `http://127.0.0.1:${port}`)

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, state.seeded ? 200 : 503, {
        status: state.seeded ? 'ok' : 'starting',
        ...buildSeedSummary(),
        lastRun: state.lastRun,
        lastError: state.lastError,
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/demo/identities') {
      writeJson(res, 200, buildSeedSummary())
      return
    }

    if (req.method === 'POST' && url.pathname === '/demo/reseed') {
      const summary = await seedDemo()
      writeJson(res, 200, summary)
      return
    }

    if (req.method === 'POST' && url.pathname === '/demo/run') {
      const summary = await runScenario()
      writeJson(res, 200, summary)
      return
    }

    writeJson(res, 404, { error: 'not_found' })
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
    writeJson(res, 500, { error: state.lastError })
  }
})

async function main() {
  server.listen(port, () => {
    console.log(`[demo-agents] listening on http://0.0.0.0:${port}`)
  })

  await seedDemo()

  const shutdown = () => {
    clients?.partnerDesk.disconnect()
    clients?.warehouse.disconnect()
    clients?.finance.disconnect()
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('[demo-agents] fatal startup error:', error)
  process.exit(1)
})
