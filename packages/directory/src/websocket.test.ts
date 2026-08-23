import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createAcl } from './acl.js'
import { createAdminSession } from './admin-auth.js'
import { createAgentApiKey, hashApiKey } from './api-key.js'
import { createDatabase, getIntentLogByNonce, listIntentTraceEvents, registerAgent, rotateAgentKey, assignDirectoryRole } from './db.js'
import { canonicalizeJson } from './crypto.js'
import { getLocalDirectoryUrl } from './federation.js'
import {
  createWebSocketServer,
  expireRecoveredIntentTimeouts,
  isAgentConnected,
  recoverInterruptedIntentsOnStartup,
  relayIntentFromHttp,
  RelayError,
  resetRelayRuntimeState,
} from './websocket.js'
import type { IntentFrame, ResultFrame } from './types.js'
import { issueWebSocketTicket, resetWebSocketTickets } from './websocket-ticket.js'

const TEST_INTENT = 'agent.ping'

afterEach(() => {
  resetRelayRuntimeState({ closeConnections: true })
  resetWebSocketTickets()
})

type FixtureAgent = {
  beamId: string
  apiKey: string
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  publicKeyBase64: string
}

function createFixtureAgent(beamId: string): FixtureAgent {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    beamId,
    apiKey: createAgentApiKey(beamId),
    privateKey,
    publicKeyBase64: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
  }
}

function registerFixtureAgent(
  db: ReturnType<typeof createDatabase>,
  agent: FixtureAgent,
  options: { displayName: string; httpEndpoint?: string | null } = { displayName: 'Fixture Agent' },
): void {
  registerAgent(db, {
    beamId: agent.beamId,
    displayName: options.displayName,
    capabilities: [TEST_INTENT],
    publicKey: agent.publicKeyBase64,
    apiKeyHash: hashApiKey(agent.apiKey),
    org: 'local',
    httpEndpoint: options.httpEndpoint ?? null,
  })
}

function signIntentFrame(
  frame: Omit<IntentFrame, 'signature'>,
  privateKey: FixtureAgent['privateKey'],
): IntentFrame {
  const payload = JSON.stringify({
    type: 'intent',
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  })

  return {
    ...frame,
    signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  }
}

function createSignedFrame(
  sender: FixtureAgent,
  to: string,
  nonce = randomUUID(),
  timestamp = new Date().toISOString(),
): IntentFrame {
  return createSignedFrameWithIntent(sender, {
    to,
    nonce,
    timestamp,
    intent: TEST_INTENT,
    payload: { message: 'hello' },
  })
}

function createSignedFrameWithIntent(
  sender: FixtureAgent,
  options: {
    to: string
    intent: string
    payload: Record<string, unknown>
    nonce?: string
    timestamp?: string
  },
): IntentFrame {
  return signIntentFrame({
    v: '1',
    from: sender.beamId,
    to: options.to,
    intent: options.intent,
    payload: options.payload,
    nonce: options.nonce ?? randomUUID(),
    timestamp: options.timestamp ?? new Date().toISOString(),
  }, sender.privateKey)
}

function createSignedResultFrame(
  responder: FixtureAgent,
  options: {
    nonce: string
    success: boolean
    payload?: Record<string, unknown>
    error?: string
    errorCode?: string
    latency?: number
    timestamp?: string
    extensions?: Record<string, unknown>
  },
): ResultFrame {
  const unsigned = {
    v: '1' as const,
    success: options.success,
    nonce: options.nonce,
    timestamp: options.timestamp ?? new Date().toISOString(),
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
    ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
    ...(options.latency !== undefined ? { latency: options.latency } : {}),
    ...options.extensions,
  }

  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalizeJson(unsigned), 'utf8'), responder.privateKey).toString('base64'),
  }
}

async function withFetchStub<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    return handler(url, init)
  }) as typeof fetch

  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function createWsHarness(db: ReturnType<typeof createDatabase>) {
  const wss = createWebSocketServer(db)
  const server = createServer()
  let closed = false

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo

  async function close() {
    if (closed) {
      return
    }
    closed = true
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    for (const client of wss.clients) {
      client.terminate()
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    close,
  }
}

async function connectClient(url: string, agent: FixtureAgent): Promise<WebSocket> {
  const ticket = issueWebSocketTicket(agent.beamId).ticket
  const ws = new WebSocket(
    `${url}?beamId=${encodeURIComponent(agent.beamId)}&ticket=${encodeURIComponent(ticket)}`,
  )
  const connectedPromise = waitForJson(ws)
  await once(ws, 'open')
  const connected = await connectedPromise
  assert.equal(connected.type, 'connected')
  assert.equal(connected.beamId, agent.beamId)
  assert.equal(connected.auth, 'ws_ticket')
  return ws
}

async function waitForJson(ws: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(ws, 'message') as [Buffer]
  return JSON.parse(data.toString()) as Record<string, unknown>
}

async function waitForMessageOrTimeout(ws: WebSocket, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      waitForJson(ws),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function closeSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return
  }

  ws.terminate()
  await once(ws, 'close')
}

function createTempDbPath(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'beam-directory-recovery-'))
  return {
    root,
    dbPath: join(root, 'beam-directory.sqlite'),
  }
}

test('relayIntentFromHttp caches direct HTTP results by nonce and suppresses duplicate deliveries', async () => {
  const db = createDatabase(':memory:')
  const sender = createFixtureAgent('sender@local.beam.directory')
  const receiver = createFixtureAgent('receiver@local.beam.directory')
  let directCalls = 0

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    registerFixtureAgent(db, receiver, {
      displayName: 'Receiver',
      httpEndpoint: 'https://direct.example/beam',
    })
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: TEST_INTENT,
      allowedFrom: sender.beamId,
    })

    const nonce = randomUUID()
    const firstFrame = createSignedFrame(sender, receiver.beamId, nonce)
    const secondFrame = createSignedFrame(sender, receiver.beamId, nonce, new Date(Date.now() + 1_000).toISOString())

    await withFetchStub(async (url) => {
      directCalls += 1
      assert.equal(url, 'https://direct.example/beam')
      return new Response(JSON.stringify({
        success: true,
        payload: { echoed: true },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }, async () => {
      const firstResult = await relayIntentFromHttp(db, firstFrame, 1_000)
      const secondResult = await relayIntentFromHttp(db, secondFrame, 1_000)

      assert.equal(firstResult.success, true)
      assert.equal(secondResult.success, true)
      assert.equal(firstResult.nonce, nonce)
      assert.deepEqual(firstResult, secondResult)
    })

    assert.equal(directCalls, 1)
  } finally {
    db.close()
  }
})

test('relayIntentFromHttp falls back to the built-in public echo responder', async () => {
  const db = createDatabase(':memory:')
  const sender = createFixtureAgent('sender@local.beam.directory')

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    const frame = createSignedFrameWithIntent(sender, {
      to: 'echo@beam.directory',
      intent: 'conversation.message',
      payload: { message: 'Hello from the browser test' },
    })

    const result = await relayIntentFromHttp(db, frame, 1_000)
    const trace = listIntentTraceEvents(db, frame.nonce)

    assert.equal(result.success, true)
    assert.equal(result.payload?.['message'], 'Echo: Hello from the browser test')
    assert.equal(result.payload?.['handledBy'], 'builtin-echo')
    assert.equal(getIntentLogByNonce(db, frame.nonce)?.status, 'acked')
    assert.ok(trace.some((entry) => entry.stage === 'delivered'))
    assert.ok(trace.some((entry) => entry.stage === 'acked'))
  } finally {
    db.close()
  }
})

test('relayIntentFromHttp rejects intents signed by a rotated-out key', async () => {
  const db = createDatabase(':memory:')
  const sender = createFixtureAgent('sender@local.beam.directory')
  const rotatedSender = createFixtureAgent('sender@local.beam.directory')
  const receiver = createFixtureAgent('receiver@local.beam.directory')

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    registerFixtureAgent(db, receiver, {
      displayName: 'Receiver',
      httpEndpoint: 'https://direct.example/beam',
    })
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: TEST_INTENT,
      allowedFrom: sender.beamId,
    })

    rotateAgentKey(db, sender.beamId, rotatedSender.publicKeyBase64)

    const staleFrame = createSignedFrame(sender, receiver.beamId)
    await withFetchStub(async () => {
      throw new Error('stale key should fail before delivery')
    }, async () => {
      await assert.rejects(
        relayIntentFromHttp(db, staleFrame, 1_000),
        (error: unknown) => error instanceof RelayError && error.code === 'BAD_REQUEST',
      )
    })

    const freshFrame = createSignedFrame(rotatedSender, receiver.beamId)
    await withFetchStub(async () => new Response(JSON.stringify({
      success: true,
      payload: { rotated: true },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), async () => {
      const result = await relayIntentFromHttp(db, freshFrame, 1_000)
      assert.equal(result.success, true)
    })
  } finally {
    db.close()
  }
})

test('websocket intent falls back to the built-in public echo responder', async () => {
  const db = createDatabase(':memory:')
  const sender = createFixtureAgent('sender@local.beam.directory')
  const harness = await createWsHarness(db)

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    const senderWs = await connectClient(harness.url, sender)

    senderWs.send(JSON.stringify({
      type: 'intent',
      frame: createSignedFrameWithIntent(sender, {
        to: 'echo@beam.directory',
        intent: 'conversation.message',
        payload: { message: 'Hello Beam' },
      }),
    }))

    const result = await waitForJson(senderWs)
    assert.equal(result.type, 'result')
    assert.equal((result.frame as { success: boolean }).success, true)
    assert.equal((result.frame as { payload: { message: string } }).payload.message, 'Echo: Hello Beam')

    await closeSocket(senderWs)
  } finally {
    await harness.close()
    db.close()
  }
})

test('websocket requires a Beam-bound credential and an invalid reconnect cannot displace the active session', async () => {
  const db = createDatabase(':memory:')
  const sender = createFixtureAgent('sender@local.beam.directory')
  const otherAgent = createFixtureAgent('other@local.beam.directory')
  const harness = await createWsHarness(db)

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    registerFixtureAgent(db, otherAgent, { displayName: 'Other' })
    const senderWs = await connectClient(harness.url, sender)

    const invalidWs = new WebSocket(
      `${harness.url}?beamId=${encodeURIComponent(sender.beamId)}&apiKey=${encodeURIComponent(otherAgent.apiKey)}`,
    )
    const invalidClosed = once(invalidWs, 'close') as Promise<[number, Buffer]>
    await once(invalidWs, 'open')
    const [closeCode, closeReason] = await invalidClosed
    assert.equal(closeCode, 1008)
    assert.equal(closeReason.toString(), 'Valid WebSocket credential required')
    assert.equal(isAgentConnected(sender.beamId), true)
    assert.equal(senderWs.readyState, WebSocket.OPEN)

    const echoResultPromise = waitForJson(senderWs)
    senderWs.send(JSON.stringify({
      type: 'intent',
      frame: createSignedFrameWithIntent(sender, {
        to: 'echo@beam.directory',
        intent: 'conversation.message',
        payload: { message: 'still connected' },
      }),
    }))
    const echoResult = await echoResultPromise
    assert.equal(echoResult.type, 'result')
    assert.equal((echoResult.frame as { success: boolean }).success, true)

    const missingKeyWs = new WebSocket(`${harness.url}?beamId=${encodeURIComponent(sender.beamId)}`)
    const missingKeyClosed = once(missingKeyWs, 'close') as Promise<[number, Buffer]>
    await once(missingKeyWs, 'open')
    const [missingKeyCode] = await missingKeyClosed
    assert.equal(missingKeyCode, 1008)
    assert.equal(isAgentConnected(sender.beamId), true)

    await closeSocket(senderWs)
  } finally {
    await harness.close()
    db.close()
  }
})

test('intent feed requires an authenticated directory admin session', async () => {
  const db = createDatabase(':memory:')
  const harness = await createWsHarness(db)

  try {
    const unauthenticatedWs = new WebSocket(`${harness.url}?feed=intents`)
    const unauthenticatedClosed = once(unauthenticatedWs, 'close') as Promise<[number, Buffer]>
    await once(unauthenticatedWs, 'open')
    const [closeCode, closeReason] = await unauthenticatedClosed
    assert.equal(closeCode, 1008)
    assert.equal(closeReason.toString(), 'Admin authentication required')

    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'websocket-test-secret'
    const email = 'feed-viewer@example.com'
    assignDirectoryRole(db, {
      userId: email,
      role: 'viewer',
      directoryUrl: getLocalDirectoryUrl(),
    })
    const session = createAdminSession(db, { email, role: 'viewer' })
    const authenticatedWs = new WebSocket(`${harness.url}?feed=intents`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
    const connectedPromise = waitForJson(authenticatedWs)
    await once(authenticatedWs, 'open')
    const connected = await connectedPromise
    assert.equal(connected.type, 'feed_connected')
    assert.equal(connected.role, 'viewer')

    await closeSocket(authenticatedWs)
  } finally {
    await harness.close()
    db.close()
  }
})

test('websocket finalizes only a fresh signed result from the intended responder', async () => {
  const db = createDatabase(':memory:')
  const sender = createFixtureAgent('sender@local.beam.directory')
  const receiver = createFixtureAgent('receiver@local.beam.directory')
  const attacker = createFixtureAgent('attacker@local.beam.directory')
  const harness = await createWsHarness(db)

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    registerFixtureAgent(db, receiver, { displayName: 'Receiver' })
    registerFixtureAgent(db, attacker, { displayName: 'Attacker' })
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: TEST_INTENT,
      allowedFrom: sender.beamId,
    })

    const senderWs = await connectClient(harness.url, sender)
    const receiverWs = await connectClient(harness.url, receiver)
    const attackerWs = await connectClient(harness.url, attacker)
    const nonce = randomUUID()
    const deliveryPromise = waitForJson(receiverWs)
    const senderResultPromise = waitForJson(senderWs)

    senderWs.send(JSON.stringify({
      type: 'intent',
      frame: createSignedFrame(sender, receiver.beamId, nonce),
    }))
    const delivery = await deliveryPromise
    assert.equal(delivery.type, 'intent')

    let rejectionPromise = waitForJson(attackerWs)
    attackerWs.send(JSON.stringify({
      type: 'result',
      frame: createSignedResultFrame(attacker, {
        nonce,
        success: true,
        payload: { forged: 'wrong responder' },
      }),
    }))
    let rejection = await rejectionPromise
    assert.equal(rejection.type, 'error')
    assert.equal(rejection.errorCode, 'FORBIDDEN')
    assert.equal(getIntentLogByNonce(db, nonce)?.status, 'delivered')

    rejectionPromise = waitForJson(receiverWs)
    receiverWs.send(JSON.stringify({
      type: 'result',
      frame: createSignedResultFrame(attacker, {
        nonce,
        success: true,
        payload: { forged: 'bad signature' },
      }),
    }))
    rejection = await rejectionPromise
    assert.equal(rejection.type, 'error')
    assert.equal(rejection.errorCode, 'BAD_REQUEST')
    assert.match(String(rejection.message), /signature verification failed/i)
    assert.equal(getIntentLogByNonce(db, nonce)?.status, 'delivered')

    rejectionPromise = waitForJson(receiverWs)
    receiverWs.send(JSON.stringify({
      type: 'result',
      frame: createSignedResultFrame(receiver, {
        nonce,
        success: true,
        payload: { stale: true },
        timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      }),
    }))
    rejection = await rejectionPromise
    assert.equal(rejection.type, 'error')
    assert.equal(rejection.errorCode, 'BAD_REQUEST')
    assert.match(String(rejection.message), /replay window/i)
    assert.equal(getIntentLogByNonce(db, nonce)?.status, 'delivered')

    receiverWs.send(JSON.stringify({
      type: 'result',
      frame: createSignedResultFrame(receiver, {
        nonce,
        success: true,
        payload: { ok: true },
      }),
    }))
    const accepted = await senderResultPromise
    assert.equal(accepted.type, 'result')
    assert.deepEqual((accepted.frame as ResultFrame).payload, { ok: true })
    assert.equal(getIntentLogByNonce(db, nonce)?.status, 'acked')

    await closeSocket(senderWs)
    await closeSocket(receiverWs)
    await closeSocket(attackerWs)
  } finally {
    await harness.close()
    db.close()
  }
})

test('websocket reconnect does not redeliver an in-flight nonce', async () => {
  const db = createDatabase(':memory:')
  const sender = createFixtureAgent('sender@local.beam.directory')
  const receiver = createFixtureAgent('receiver@local.beam.directory')
  const harness = await createWsHarness(db)

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    registerFixtureAgent(db, receiver, { displayName: 'Receiver' })
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: TEST_INTENT,
      allowedFrom: sender.beamId,
    })

    const receiverWs = await connectClient(harness.url, receiver)
    const senderWs = await connectClient(harness.url, sender)
    const nonce = randomUUID()
    const firstDeliveryPromise = waitForJson(receiverWs)

    senderWs.send(JSON.stringify({
      type: 'intent',
      frame: createSignedFrame(sender, receiver.beamId, nonce),
    }))

    const firstDelivery = await firstDeliveryPromise
    assert.equal(firstDelivery.type, 'intent')
    assert.equal((firstDelivery.frame as { nonce: string }).nonce, nonce)

    await closeSocket(senderWs)

    const senderReconnect = await connectClient(harness.url, sender)
    const duplicateAttemptPromise = waitForJson(senderReconnect)
    senderReconnect.send(JSON.stringify({
      type: 'intent',
      frame: createSignedFrame(sender, receiver.beamId, nonce, new Date(Date.now() + 1_000).toISOString()),
    }))

    const duplicateAttempt = await duplicateAttemptPromise
    assert.equal(duplicateAttempt.type, 'error')
    assert.equal(duplicateAttempt.errorCode, 'IN_PROGRESS')

    const unexpectedSecondDelivery = await waitForMessageOrTimeout(receiverWs, 120)
    assert.equal(unexpectedSecondDelivery, null)

    receiverWs.send(JSON.stringify({
      type: 'result',
      frame: createSignedResultFrame(receiver, {
        success: true,
        nonce,
        payload: { ok: true },
      }),
    }))

    await closeSocket(senderReconnect)
    await closeSocket(receiverWs)
  } finally {
    await harness.close()
    db.close()
  }
})

test('relayIntentFromHttp records a retryable timeout for unanswered websocket deliveries', async () => {
  const db = createDatabase(':memory:')
  const sender = createFixtureAgent('sender@local.beam.directory')
  const receiver = createFixtureAgent('receiver@local.beam.directory')
  const harness = await createWsHarness(db)

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    registerFixtureAgent(db, receiver, { displayName: 'Receiver' })
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: TEST_INTENT,
      allowedFrom: sender.beamId,
    })

    const receiverWs = await connectClient(harness.url, receiver)
    const frame = createSignedFrame(sender, receiver.beamId)
    const deliveredIntentPromise = waitForJson(receiverWs)

    await assert.rejects(
      relayIntentFromHttp(db, frame, 25),
      (err: unknown) => err instanceof RelayError && err.code === 'TIMEOUT',
    )

    const deliveredIntent = await deliveredIntentPromise
    assert.equal(deliveredIntent.type, 'intent')
    assert.equal((deliveredIntent.frame as { nonce: string }).nonce, frame.nonce)

    const log = getIntentLogByNonce(db, frame.nonce)
    assert.ok(log)
    assert.equal(log?.status, 'failed')
    assert.equal(log?.error_code, 'TIMEOUT')
    assert.match(log?.result_json ?? '', /"errorCode":"TIMEOUT"/)

    await closeSocket(receiverWs)
  } finally {
    await harness.close()
    db.close()
  }
})

test('directory restart resumes delivered intents and serves a cached late result without redelivery', async () => {
  const { root, dbPath } = createTempDbPath()
  let db = createDatabase(dbPath)
  const sender = createFixtureAgent('sender@local.beam.directory')
  const receiver = createFixtureAgent('receiver@local.beam.directory')
  let harness = await createWsHarness(db)

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    registerFixtureAgent(db, receiver, { displayName: 'Receiver' })
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: TEST_INTENT,
      allowedFrom: sender.beamId,
    })

    const receiverWs = await connectClient(harness.url, receiver)
    const senderWs = await connectClient(harness.url, sender)
    const nonce = randomUUID()

    senderWs.send(JSON.stringify({
      type: 'intent',
      frame: createSignedFrame(sender, receiver.beamId, nonce),
    }))

    const firstDelivery = await waitForJson(receiverWs)
    assert.equal(firstDelivery.type, 'intent')
    assert.equal((firstDelivery.frame as { nonce: string }).nonce, nonce)
    assert.equal(getIntentLogByNonce(db, nonce)?.status, 'delivered')

    await closeSocket(senderWs)
    await closeSocket(receiverWs)
    await harness.close()
    db.close()
    resetRelayRuntimeState({ closeConnections: true, rejectPending: true })

    db = createDatabase(dbPath)
    const recovery = recoverInterruptedIntentsOnStartup(db)
    assert.deepEqual(recovery, {
      failedInterrupted: 0,
      resumedAwaitingResult: 1,
      timedOutAwaitingResult: 0,
    })

    harness = await createWsHarness(db)
    const restartedReceiverWs = await connectClient(harness.url, receiver)
    restartedReceiverWs.send(JSON.stringify({
      type: 'result',
      frame: createSignedResultFrame(receiver, {
        success: true,
        nonce,
        payload: { ok: true },
      }),
    }))

    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(getIntentLogByNonce(db, nonce)?.status, 'acked')

    const restartedSenderWs = await connectClient(harness.url, sender)
    const cachedResultPromise = waitForJson(restartedSenderWs)
    restartedSenderWs.send(JSON.stringify({
      type: 'intent',
      frame: createSignedFrame(sender, receiver.beamId, nonce, new Date(Date.now() + 1_000).toISOString()),
    }))

    const cachedResult = await cachedResultPromise
    assert.equal(cachedResult.type, 'result')
    assert.equal((cachedResult.frame as { nonce: string }).nonce, nonce)
    assert.deepEqual((cachedResult.frame as { payload: Record<string, unknown> }).payload, { ok: true })

    const unexpectedSecondDelivery = await waitForMessageOrTimeout(restartedReceiverWs, 120)
    assert.equal(unexpectedSecondDelivery, null)

    const trace = listIntentTraceEvents(db, nonce)
    assert.equal(trace.filter((entry) => entry.stage === 'delivered').length, 1)
    assert.equal(trace.filter((entry) => entry.stage === 'acked').length, 1)

    await closeSocket(restartedSenderWs)
    await closeSocket(restartedReceiverWs)
  } finally {
    await harness.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('directory restart expires recovered delivered intents after the original timeout window', async () => {
  const { root, dbPath } = createTempDbPath()
  let db = createDatabase(dbPath)
  const sender = createFixtureAgent('sender@local.beam.directory')
  const receiver = createFixtureAgent('receiver@local.beam.directory')
  let harness = await createWsHarness(db)

  try {
    registerFixtureAgent(db, sender, { displayName: 'Sender' })
    registerFixtureAgent(db, receiver, { displayName: 'Receiver' })
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: TEST_INTENT,
      allowedFrom: sender.beamId,
    })

    const receiverWs = await connectClient(harness.url, receiver)
    const nonce = randomUUID()
    const frame = createSignedFrame(sender, receiver.beamId, nonce)
    const deliveryPromise = waitForJson(receiverWs)

    const relayPromise = relayIntentFromHttp(db, frame, 30_000).catch(() => null)
    const deliveredIntent = await deliveryPromise
    assert.equal(deliveredIntent.type, 'intent')
    assert.equal((deliveredIntent.frame as { nonce: string }).nonce, nonce)

    await closeSocket(receiverWs)
    await harness.close()
    db.close()
    resetRelayRuntimeState({ closeConnections: true, rejectPending: true })
    await relayPromise

    db = createDatabase(dbPath)
    const requestedAtMs = new Date(frame.timestamp).getTime()
    const recovered = recoverInterruptedIntentsOnStartup(db, {
      nowMs: requestedAtMs + 5_000,
      defaultTimeoutMs: 30_000,
    })
    assert.deepEqual(recovered, {
      failedInterrupted: 0,
      resumedAwaitingResult: 1,
      timedOutAwaitingResult: 0,
    })

    const expired = expireRecoveredIntentTimeouts(db, {
      nowMs: requestedAtMs + 35_000,
      defaultTimeoutMs: 30_000,
    })
    assert.equal(expired, 1)

    const log = getIntentLogByNonce(db, nonce)
    assert.ok(log)
    assert.equal(log?.status, 'failed')
    assert.equal(log?.error_code, 'TIMEOUT')
    assert.match(log?.result_json ?? '', /"errorCode":"TIMEOUT"/)
  } finally {
    await harness.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
