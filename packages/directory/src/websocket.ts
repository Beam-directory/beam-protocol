import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Database } from 'better-sqlite3'
import type { IntentFrame, ResultFrame } from './types.js'
import { finalizeIntentLog, getAgent, hasActiveDelegation, logIntentStart, recordNonce, updateLastSeen } from './db.js'
import { isIntentAllowed } from './acl.js'
import {
  getCachedFederatedPublicKey,
  getFederationRequestHeaders,
  getLocalDirectoryUrl,
  MAX_FEDERATION_HOPS,
  queryPeerForAgent,
  resolveAgentAcrossFederation,
} from './federation.js'
import { validateIntentPayload } from './validation.js'
import { checkAgentRateLimit, getRateLimitPerMinute, pruneRateLimitState } from './rate-limit.js'
import { verifyPayload } from './crypto.js'

const REPLAY_WINDOW_MS = 5 * 60 * 1000

const connections = new Map<string, WebSocket>()
const intentFeedSubscribers = new Set<WebSocket>()

const pendingResults = new Map<string, {
  db: Database
  fromBeamId: string
  toBeamId: string
  intentType: string
  startedAtMs: number
  resolve: (frame: ResultFrame) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

setInterval(() => {
  pruneRateLimitState()
}, 60_000).unref()

export class RelayError extends Error {
  code: 'OFFLINE' | 'BAD_REQUEST' | 'DELIVERY_FAILED' | 'TIMEOUT' | 'RATE_LIMITED' | 'FORBIDDEN'

  constructor(code: RelayError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export function createWebSocketServer(db: Database): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const urlStr = req.url ?? '/'
    const url = new URL(urlStr, 'http://localhost')
    const feed = url.searchParams.get('feed')

    if (feed === 'intents') {
      intentFeedSubscribers.add(ws)
      sendJson(ws, { type: 'feed_connected' })

      ws.on('close', () => {
        intentFeedSubscribers.delete(ws)
      })

      ws.on('error', () => {
        intentFeedSubscribers.delete(ws)
      })

      return
    }

    const beamId = url.searchParams.get('beamId')

    if (!beamId) {
      ws.close(1008, 'Missing beamId query parameter')
      return
    }

    const agent = getAgent(db, beamId)
    if (!agent) {
      ws.close(1008, `Agent ${beamId} is not registered`)
      return
    }

    const existingWs = connections.get(beamId)
    if (existingWs && existingWs.readyState === WebSocket.OPEN) {
      existingWs.close(1001, 'Replaced by new connection')
    }

    connections.set(beamId, ws)
    updateLastSeen(db, beamId)

    sendJson(ws, { type: 'connected', beamId })

    ws.on('message', (data: Buffer) => {
      void handleMessage(db, beamId, ws, data)
    })

    ws.on('close', () => {
      if (connections.get(beamId) === ws) {
        connections.delete(beamId)
      }
    })

    ws.on('error', (err: Error) => {
      console.error(`WebSocket error for ${beamId}:`, err)
      if (connections.get(beamId) === ws) {
        connections.delete(beamId)
      }
    })
  })

  return wss
}

export function getConnectedCount(): number {
  return connections.size
}

export function isAgentConnected(beamId: string): boolean {
  const ws = connections.get(beamId)
  return Boolean(ws && ws.readyState === WebSocket.OPEN)
}

export function getConnectedBeamIds(): string[] {
  return Array.from(connections.entries())
    .filter(([, ws]) => ws.readyState === WebSocket.OPEN)
    .map(([beamId]) => beamId)
}

export async function relayIntentFromHttp(
  db: Database,
  frame: IntentFrame,
  timeoutMs = 60_000,
  options: { sourceDirectory?: string; hopCount?: number } = {}
): Promise<ResultFrame> {
  const prepared = normalizeAndValidateFrame(frame)
  const sourceDirectory = options.sourceDirectory ?? getLocalDirectoryUrl()
  const hopCount = options.hopCount ?? 0

  if (hopCount > MAX_FEDERATION_HOPS) {
    throw new RelayError('BAD_REQUEST', `Federation hop limit exceeded (${MAX_FEDERATION_HOPS})`)
  }

  const sender = getAgent(db, prepared.from)
  const senderPublicKey = sender?.public_key ?? await resolveSenderPublicKey(db, prepared.from, sourceDirectory)

  if (!senderPublicKey) {
    throw new RelayError('BAD_REQUEST', `Sender ${prepared.from} is not registered`)
  }

  enforceSecurityChecks(db, prepared, senderPublicKey)

  logIntentStart(db, prepared)
  broadcastIntentFeed({
    nonce: prepared.nonce,
    from: prepared.from,
    to: prepared.to,
    intentType: prepared.intent,
    timestamp: prepared.timestamp,
    completedAt: null,
    roundTripLatencyMs: null,
    status: 'pending',
    errorCode: null,
  })

  const localRecipient = getAgent(db, prepared.to)
  if (!localRecipient) {
    const federatedResult = await relayIntentToFederatedPeer(db, prepared, timeoutMs, {
      sourceDirectory,
      hopCount,
    })
    updateLastSeen(db, prepared.from)
    return federatedResult
  }

  const recipientWs = connections.get(prepared.to)
  if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
    finalizeIntentLog(db, {
      nonce: prepared.nonce,
      fromBeamId: prepared.from,
      toBeamId: prepared.to,
      success: false,
      latencyMs: null,
      errorCode: 'OFFLINE',
    })
    broadcastIntentFeed({
      nonce: prepared.nonce,
      from: prepared.from,
      to: prepared.to,
      intentType: prepared.intent,
      timestamp: prepared.timestamp,
      completedAt: new Date().toISOString(),
      roundTripLatencyMs: null,
      status: 'error',
      errorCode: 'OFFLINE',
    })
    throw new RelayError('OFFLINE', `Agent ${prepared.to} is not currently connected`)
  }

  const resultPromise = createResultWaiter(db, prepared, timeoutMs)

  try {
    sendJson(recipientWs, {
      type: 'intent',
      frame: prepared,
      senderPublicKey,
    })
  } catch (err) {
    clearPendingResult(prepared.nonce)
    finalizeIntentLog(db, {
      nonce: prepared.nonce,
      fromBeamId: prepared.from,
      toBeamId: prepared.to,
      success: false,
      latencyMs: null,
      errorCode: 'DELIVERY_FAILED',
    })
    broadcastIntentFeed({
      nonce: prepared.nonce,
      from: prepared.from,
      to: prepared.to,
      intentType: prepared.intent,
      timestamp: prepared.timestamp,
      completedAt: new Date().toISOString(),
      roundTripLatencyMs: null,
      status: 'error',
      errorCode: 'DELIVERY_FAILED',
    })
    throw new RelayError('DELIVERY_FAILED', err instanceof Error ? err.message : 'Failed to relay intent')
  }

  updateLastSeen(db, prepared.from)
  return resultPromise
}

async function handleMessage(
  db: Database,
  senderBeamId: string,
  senderWs: WebSocket,
  data: Buffer
): Promise<void> {
  let msg: { type: string; frame: IntentFrame | ResultFrame }

  try {
    msg = JSON.parse(data.toString()) as { type: string; frame: IntentFrame | ResultFrame }
  } catch {
    sendJson(senderWs, { type: 'error', message: 'Invalid message format: must be valid JSON' })
    return
  }

  if (!msg || typeof msg.type !== 'string') {
    sendJson(senderWs, { type: 'error', message: 'Invalid message: missing type field' })
    return
  }

  if (msg.type === 'intent') {
    await handleIntent(db, senderBeamId, senderWs, msg.frame as IntentFrame)
  } else if (msg.type === 'result') {
    handleResult(msg.frame as ResultFrame)
  } else {
    sendJson(senderWs, { type: 'error', message: `Unknown message type: ${msg.type}` })
  }
}

async function handleIntent(
  db: Database,
  senderBeamId: string,
  senderWs: WebSocket,
  frame: IntentFrame
): Promise<void> {
  let prepared: IntentFrame
  try {
    prepared = normalizeAndValidateFrame(frame)
  } catch (err) {
    sendJson(senderWs, {
      type: 'error',
      nonce: typeof frame?.nonce === 'string' ? frame.nonce : undefined,
      errorCode: 'INVALID_INTENT',
      message: err instanceof Error ? err.message : 'Invalid intent frame',
    })
    return
  }

  let senderAgent
  try {
    senderAgent = resolveIntentSender(db, senderBeamId, prepared)
  } catch (err) {
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: err instanceof RelayError ? err.code : 'UNKNOWN_SENDER',
      message: err instanceof Error ? err.message : 'Sender is not registered in the directory',
    })
    return
  }

  try {
    enforceSecurityChecks(db, prepared, senderAgent.public_key)
  } catch (err) {
    if (err instanceof RelayError && err.code === 'RATE_LIMITED') {
      sendJson(senderWs, {
        type: 'error',
        nonce: prepared.nonce,
        errorCode: 'RATE_LIMITED',
        status: 429,
        message: err.message,
      })
      return
    }

    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: err instanceof RelayError ? err.code : 'INVALID_INTENT',
      message: err instanceof Error ? err.message : 'Rejected by relay security checks',
    })
    return
  }

  logIntentStart(db, prepared)
  broadcastIntentFeed({
    nonce: prepared.nonce,
    from: prepared.from,
    to: prepared.to,
    intentType: prepared.intent,
    timestamp: prepared.timestamp,
    completedAt: null,
    roundTripLatencyMs: null,
    status: 'pending',
    errorCode: null,
  })

  const localRecipient = getAgent(db, prepared.to)
  if (!localRecipient) {
    try {
      const result = await relayIntentToFederatedPeer(db, prepared, 30_000, {
        sourceDirectory: getLocalDirectoryUrl(),
        hopCount: 0,
      })
      updateLastSeen(db, senderBeamId)
      sendJson(senderWs, { type: 'result', frame: result })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Federated delivery failed'
      sendJson(senderWs, {
        type: 'error',
        nonce: prepared.nonce,
        errorCode: err instanceof RelayError ? err.code : 'DELIVERY_FAILED',
        message,
      })
    }
    return
  }

  const recipientWs = connections.get(prepared.to)
  if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
    finalizeIntentLog(db, {
      nonce: prepared.nonce,
      fromBeamId: prepared.from,
      toBeamId: prepared.to,
      success: false,
      latencyMs: null,
      errorCode: 'OFFLINE',
    })
    broadcastIntentFeed({
      nonce: prepared.nonce,
      from: prepared.from,
      to: prepared.to,
      intentType: prepared.intent,
      timestamp: prepared.timestamp,
      completedAt: new Date().toISOString(),
      roundTripLatencyMs: null,
      status: 'error',
      errorCode: 'OFFLINE',
    })
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: 'OFFLINE',
      message: `Agent ${prepared.to} is not currently connected`,
    })
    return
  }

  const resultPromise = createResultWaiter(db, prepared, 30_000)

  sendJson(recipientWs, {
    type: 'intent',
    frame: prepared,
    senderPublicKey: senderAgent.public_key,
    actingBeamId: senderBeamId !== prepared.from ? senderBeamId : undefined,
  })

  updateLastSeen(db, senderBeamId)

  try {
    const result = await resultPromise
    sendJson(senderWs, { type: 'result', frame: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delivery failed'
    sendJson(senderWs, { type: 'error', nonce: prepared.nonce, message })
  }
}

async function resolveSenderPublicKey(
  db: Database,
  beamId: string,
  sourceDirectory: string
): Promise<string | null> {
  const local = getAgent(db, beamId)
  if (local) {
    return local.public_key
  }

  const cached = getCachedFederatedPublicKey(db, beamId)
  if (cached) {
    return cached
  }

  if (sourceDirectory && sourceDirectory !== getLocalDirectoryUrl()) {
    const fromSource = await queryPeerForAgent(db, sourceDirectory, beamId, { localOnly: true })
    const publicKey = fromSource?.agent.public_key ?? fromSource?.agent.publicKey
    if (typeof publicKey === 'string' && publicKey.length > 0) {
      return publicKey
    }
  }

  const resolved = await resolveAgentAcrossFederation(db, beamId, { autoDiscover: false })
  const publicKey = resolved?.agent.public_key ?? resolved?.agent.publicKey
  return typeof publicKey === 'string' && publicKey.length > 0 ? publicKey : null
}

async function relayIntentToFederatedPeer(
  db: Database,
  frame: IntentFrame,
  timeoutMs: number,
  options: { sourceDirectory: string; hopCount: number }
): Promise<ResultFrame> {
  const resolved = await resolveAgentAcrossFederation(db, frame.to)
  const peerUrl = resolved?.directoryUrl

  if (!resolved || !peerUrl || peerUrl === getLocalDirectoryUrl()) {
    finalizeIntentLog(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      success: false,
      latencyMs: null,
      errorCode: 'OFFLINE',
    })
    throw new RelayError('OFFLINE', `Agent ${frame.to} is not available locally or through federation`)
  }

  const nextHopCount = options.hopCount + 1
  if (nextHopCount > MAX_FEDERATION_HOPS) {
    finalizeIntentLog(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      success: false,
      latencyMs: null,
      errorCode: 'BAD_REQUEST',
    })
    throw new RelayError('BAD_REQUEST', `Federation hop limit exceeded (${MAX_FEDERATION_HOPS})`)
  }

  const startedAt = Date.now()
  const response = await fetch(`${peerUrl}/federation/relay`, {
    method: 'POST',
    headers: getFederationRequestHeaders({
      'Content-Type': 'application/json',
      'X-Beam-Source-Directory': options.sourceDirectory,
      'X-Beam-Hop-Count': String(nextHopCount),
    }),
    body: JSON.stringify(frame),
  })

  if (!response.ok) {
    finalizeIntentLog(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      success: false,
      latencyMs: Date.now() - startedAt,
      errorCode: 'DELIVERY_FAILED',
    })
    throw new RelayError('DELIVERY_FAILED', `Federated relay failed with status ${response.status}`)
  }

  const result = await response.json() as ResultFrame
  finalizeIntentLog(db, {
    nonce: frame.nonce,
    fromBeamId: frame.from,
    toBeamId: frame.to,
    success: result.success,
    latencyMs: typeof result.latency === 'number' ? result.latency : Date.now() - startedAt,
    errorCode: result.success ? undefined : (result.errorCode ?? 'RESULT_ERROR'),
  })

  return result
}

function normalizeAndValidateFrame(frame: IntentFrame): IntentFrame {
  if (!frame || typeof frame !== 'object') {
    throw new RelayError('BAD_REQUEST', 'Invalid intent frame body')
  }

  const payloadCandidate = (frame as unknown as { payload?: unknown; params?: unknown }).payload
    ?? (frame as unknown as { params?: unknown }).params

  const payload = (payloadCandidate && typeof payloadCandidate === 'object' && !Array.isArray(payloadCandidate))
    ? payloadCandidate as Record<string, unknown>
    : null

  if (typeof frame.from !== 'string' || typeof frame.to !== 'string' || typeof frame.intent !== 'string') {
    throw new RelayError('BAD_REQUEST', 'from, to and intent are required')
  }
  if (!payload) {
    throw new RelayError('BAD_REQUEST', 'payload must be an object')
  }
  if (typeof frame.nonce !== 'string' || frame.nonce.length === 0) {
    throw new RelayError('BAD_REQUEST', 'nonce is required')
  }
  if (typeof frame.timestamp !== 'string' || frame.timestamp.length === 0) {
    throw new RelayError('BAD_REQUEST', 'timestamp is required')
  }
  if (typeof frame.signature !== 'string' || frame.signature.length === 0) {
    throw new RelayError('BAD_REQUEST', 'signature is required')
  }

  return {
    ...frame,
    payload,
  }
}

export function canActOnBehalf(
  db: Database,
  connectedBeamId: string,
  claimedFromBeamId: string,
  intentType: string,
): boolean {
  if (connectedBeamId === claimedFromBeamId) {
    return true
  }

  return hasActiveDelegation(db, {
    grantorBeamId: claimedFromBeamId,
    granteeBeamId: connectedBeamId,
    scope: intentType,
  })
}

function resolveIntentSender(db: Database, connectedBeamId: string, frame: IntentFrame) {
  const senderAgent = getAgent(db, connectedBeamId)
  if (!senderAgent) {
    throw new RelayError('BAD_REQUEST', 'Sender is not registered in the directory')
  }

  if (!canActOnBehalf(db, connectedBeamId, frame.from, frame.intent)) {
    throw new RelayError(
      connectedBeamId === frame.from ? 'BAD_REQUEST' : 'FORBIDDEN',
      connectedBeamId === frame.from
        ? 'Sender is not registered in the directory'
        : `No active delegation allows ${connectedBeamId} to send ${frame.intent} for ${frame.from}`,
    )
  }

  return senderAgent
}

function enforceSecurityChecks(db: Database, frame: IntentFrame, senderPublicKey: string): void {
  if (!checkAgentRateLimit(frame.from, getRateLimitPerMinute())) {
    throw new RelayError('RATE_LIMITED', `Rate limit exceeded for ${frame.from}`)
  }

  if (!verifyIntentSignature(frame, senderPublicKey)) {
    throw new RelayError('BAD_REQUEST', 'Signature verification failed')
  }

  const localTarget = getAgent(db, frame.to)
  if (localTarget && !isIntentAllowed(db, {
    targetBeamId: frame.to,
    intentType: frame.intent,
    fromBeamId: frame.from,
  })) {
    throw new RelayError('FORBIDDEN', `ACL denied intent ${frame.intent} from ${frame.from} to ${frame.to}`)
  }

  const payloadValidation = validateIntentPayload(frame.intent, frame.payload)
  if (!payloadValidation.valid) {
    throw new RelayError('BAD_REQUEST', payloadValidation.error ?? 'Invalid payload')
  }

  enforceReplayProtection(db, frame)
}

function enforceReplayProtection(db: Database, frame: IntentFrame): void {
  const parsedTimestamp = new Date(frame.timestamp).getTime()
  if (Number.isNaN(parsedTimestamp)) {
    throw new RelayError('BAD_REQUEST', 'Invalid timestamp format')
  }

  if (Math.abs(Date.now() - parsedTimestamp) > REPLAY_WINDOW_MS) {
    throw new RelayError('BAD_REQUEST', 'Timestamp outside allowed replay window (5 minutes)')
  }

  const isNewNonce = recordNonce(db, frame.nonce)
  if (!isNewNonce) {
    throw new RelayError('BAD_REQUEST', `Replay detected: nonce ${frame.nonce} was already used`)
  }
}

function verifyIntentSignature(frame: IntentFrame, senderPublicKeyBase64: string): boolean {
  // K4 FIX: Pass object directly to verifyPayload, not JSON.stringify'd string.
  // verifyPayload() calls canonicalizeJson() internally which handles deterministic serialization.
  // Previously: JSON.stringify → string → canonicalizeJson(string) = double-encoded.
  const signedPayload = {
    type: 'intent' as const,
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  }

  return verifyPayload(signedPayload, frame.signature ?? '', senderPublicKeyBase64)
}

function handleResult(frame: ResultFrame): void {
  if (!frame || typeof frame.nonce !== 'string') {
    return
  }

  const pending = pendingResults.get(frame.nonce)
  if (!pending) {
    return
  }

  clearTimeout(pending.timeout)
  pendingResults.delete(frame.nonce)
  const latencyMs = typeof frame.latency === 'number' ? frame.latency : Math.max(0, Date.now() - pending.startedAtMs)
  finalizeIntentLog(pending.db, {
    nonce: frame.nonce,
    fromBeamId: pending.fromBeamId,
    toBeamId: pending.toBeamId,
    success: frame.success,
    latencyMs,
    errorCode: frame.success ? undefined : (frame.errorCode ?? 'RESULT_ERROR'),
  })
  broadcastIntentFeed({
    nonce: frame.nonce,
    from: pending.fromBeamId,
    to: pending.toBeamId,
    intentType: pending.intentType,
    timestamp: new Date(pending.startedAtMs).toISOString(),
    completedAt: new Date().toISOString(),
    roundTripLatencyMs: latencyMs,
    status: frame.success ? 'success' : 'error',
    errorCode: frame.success ? null : (frame.errorCode ?? 'RESULT_ERROR'),
  })
  pending.resolve(frame)
}

function createResultWaiter(db: Database, frame: IntentFrame, timeoutMs: number): Promise<ResultFrame> {
  if (pendingResults.has(frame.nonce)) {
    clearPendingResult(frame.nonce)
  }

  const startedAtMs = new Date(frame.timestamp).getTime()
  const safeStartedAtMs = Number.isNaN(startedAtMs) ? Date.now() : startedAtMs

  return new Promise<ResultFrame>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResults.delete(frame.nonce)
      const latencyMs = Math.max(0, Date.now() - safeStartedAtMs)
      finalizeIntentLog(db, {
        nonce: frame.nonce,
        fromBeamId: frame.from,
        toBeamId: frame.to,
        success: false,
        latencyMs,
        errorCode: 'TIMEOUT',
      })
      broadcastIntentFeed({
        nonce: frame.nonce,
        from: frame.from,
        to: frame.to,
        intentType: frame.intent,
        timestamp: frame.timestamp,
        completedAt: new Date().toISOString(),
        roundTripLatencyMs: latencyMs,
        status: 'error',
        errorCode: 'TIMEOUT',
      })
      reject(new RelayError('TIMEOUT', `Intent timed out waiting for result (${timeoutMs}ms)`))
    }, timeoutMs)

    pendingResults.set(frame.nonce, {
      db,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      startedAtMs: safeStartedAtMs,
      resolve,
      reject,
      timeout,
    })
  })
}

function clearPendingResult(nonce: string): void {
  const pending = pendingResults.get(nonce)
  if (!pending) return
  clearTimeout(pending.timeout)
  pendingResults.delete(nonce)
}

function sendJson(ws: WebSocket, payload: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function broadcastIntentFeed(entry: {
  nonce: string
  from: string
  to: string
  intentType: string
  timestamp: string
  completedAt: string | null
  roundTripLatencyMs: number | null
  status: string
  errorCode: string | null
}): void {
  for (const ws of intentFeedSubscribers) {
    if (ws.readyState !== WebSocket.OPEN) {
      intentFeedSubscribers.delete(ws)
      continue
    }

    sendJson(ws, {
      type: 'intent_feed',
      entry,
    })
  }
}
