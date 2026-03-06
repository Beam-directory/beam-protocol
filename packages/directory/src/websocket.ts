import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Database } from 'better-sqlite3'
import type { IntentFrame, ResultFrame } from './types.js'
import { getAgent, updateLastSeen } from './db.js'

const connections = new Map<string, WebSocket>()

const pendingResults = new Map<string, {
  resolve: (frame: ResultFrame) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

export class RelayError extends Error {
  code: 'OFFLINE' | 'BAD_REQUEST' | 'DELIVERY_FAILED' | 'TIMEOUT'

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
  if (!frame || typeof frame !== 'object') {
    throw new RelayError('BAD_REQUEST', 'Invalid intent frame body')
  }
  if (typeof frame.from !== 'string' || typeof frame.to !== 'string' || typeof frame.intent !== 'string') {
    throw new RelayError('BAD_REQUEST', 'from, to and intent are required')
  }
  if (!frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params)) {
    throw new RelayError('BAD_REQUEST', 'params must be an object')
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

  const sender = getAgent(db, frame.from)
  if (!sender) {
    throw new RelayError('BAD_REQUEST', `Sender ${frame.from} is not registered`)
  }

  const recipientWs = connections.get(frame.to)
  if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
    throw new RelayError('OFFLINE', `Agent ${frame.to} is not currently connected`)
  }

  const resultPromise = createResultWaiter(frame.nonce, timeoutMs)

  try {
    sendJson(recipientWs, {
      type: 'intent',
      frame,
      senderPublicKey: sender.public_key,
    })
  } catch (err) {
    clearPendingResult(frame.nonce)
    throw new RelayError('DELIVERY_FAILED', err instanceof Error ? err.message : 'Failed to relay intent')
  }

  updateLastSeen(db, frame.from)
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
  if (!frame || typeof frame.nonce !== 'string' || typeof frame.to !== 'string') {
    sendJson(senderWs, {
      type: 'error',
      message: 'Invalid intent frame: missing required fields (nonce, to)',
    })
    return
  }

  if (frame.from !== senderBeamId) {
    sendJson(senderWs, {
      type: 'error',
      nonce: frame.nonce,
      message: `from field (${frame.from}) does not match connected beamId (${senderBeamId})`,
    })
    return
  }

  const senderAgent = getAgent(db, senderBeamId)
  if (!senderAgent) {
    sendJson(senderWs, {
      type: 'error',
      nonce: frame.nonce,
      message: 'Sender is not registered in the directory',
    })
    return
  }

  const recipientWs = connections.get(frame.to)
  if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
    sendJson(senderWs, {
      type: 'error',
      nonce: frame.nonce,
      message: `Agent ${frame.to} is not currently connected`,
    })
    return
  }

  const resultPromise = createResultWaiter(frame.nonce, 30_000)

  sendJson(recipientWs, {
    type: 'intent',
    frame,
    senderPublicKey: senderAgent.public_key,
  })

  updateLastSeen(db, senderBeamId)

  try {
    const result = await resultPromise
    sendJson(senderWs, { type: 'result', frame: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delivery failed'
    sendJson(senderWs, { type: 'error', nonce: frame.nonce, message })
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
