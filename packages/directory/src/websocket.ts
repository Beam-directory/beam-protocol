import { createPublicKey, verify } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Database } from 'better-sqlite3'
import type { IntentFrame, ResultFrame } from './types.js'
import { getAgent, recordNonce, updateLastSeen } from './db.js'
import { isIntentAllowed } from './acl.js'
import { validateIntentPayload } from './validation.js'
import { checkAgentRateLimit, getRateLimitPerMinute, pruneRateLimitState } from './rate-limit.js'

const REPLAY_WINDOW_MS = 5 * 60 * 1000

const connections = new Map<string, WebSocket>()

const pendingResults = new Map<string, {
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

export async function relayIntentFromHttp(db: Database, frame: IntentFrame, timeoutMs = 60_000): Promise<ResultFrame> {
  const prepared = normalizeAndValidateFrame(frame)
  const sender = getAgent(db, prepared.from)

  if (!sender) {
    throw new RelayError('BAD_REQUEST', `Sender ${prepared.from} is not registered`)
  }

  enforceSecurityChecks(db, prepared, sender.public_key)

  const recipientWs = connections.get(prepared.to)
  if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
    throw new RelayError('OFFLINE', `Agent ${prepared.to} is not currently connected`)
  }

  const resultPromise = createResultWaiter(prepared.nonce, timeoutMs)

  try {
    sendJson(recipientWs, {
      type: 'intent',
      frame: prepared,
      senderPublicKey: sender.public_key,
    })
  } catch (err) {
    clearPendingResult(prepared.nonce)
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

  if (prepared.from !== senderBeamId) {
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: 'SENDER_MISMATCH',
      message: `from field (${prepared.from}) does not match connected beamId (${senderBeamId})`,
    })
    return
  }

  const senderAgent = getAgent(db, senderBeamId)
  if (!senderAgent) {
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: 'UNKNOWN_SENDER',
      message: 'Sender is not registered in the directory',
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

  const recipientWs = connections.get(prepared.to)
  if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
    sendJson(senderWs, {
      type: 'error',
      nonce: prepared.nonce,
      errorCode: 'OFFLINE',
      message: `Agent ${prepared.to} is not currently connected`,
    })
    return
  }

  const resultPromise = createResultWaiter(prepared.nonce, 30_000)

  sendJson(recipientWs, {
    type: 'intent',
    frame: prepared,
    senderPublicKey: senderAgent.public_key,
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

function enforceSecurityChecks(db: Database, frame: IntentFrame, senderPublicKey: string): void {
  if (!checkAgentRateLimit(frame.from, getRateLimitPerMinute())) {
    throw new RelayError('RATE_LIMITED', `Rate limit exceeded for ${frame.from}`)
  }

  if (!verifyIntentSignature(frame, senderPublicKey)) {
    throw new RelayError('BAD_REQUEST', 'Signature verification failed')
  }

  if (!isIntentAllowed(db, {
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
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(senderPublicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })

    const signedPayload = JSON.stringify({
      type: 'intent',
      from: frame.from,
      to: frame.to,
      intent: frame.intent,
      payload: frame.payload,
      timestamp: frame.timestamp,
      nonce: frame.nonce,
    })

    return verify(
      null,
      Buffer.from(signedPayload, 'utf8'),
      publicKey,
      Buffer.from(frame.signature ?? '', 'base64')
    )
  } catch {
    return false
  }
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
  pending.resolve(frame)
}

function createResultWaiter(nonce: string, timeoutMs: number): Promise<ResultFrame> {
  if (pendingResults.has(nonce)) {
    clearPendingResult(nonce)
  }

  return new Promise<ResultFrame>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResults.delete(nonce)
      reject(new RelayError('TIMEOUT', `Intent timed out waiting for result (${timeoutMs}ms)`))
    }, timeoutMs)

    pendingResults.set(nonce, { resolve, reject, timeout })
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
