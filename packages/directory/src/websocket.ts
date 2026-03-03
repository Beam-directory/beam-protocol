import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Database } from 'better-sqlite3'
import type { IntentFrame, ResultFrame } from './types.js'
import { getAgent, updateLastSeen } from './db.js'

// ---------------------------------------------------------------------------
// Connection registry
// ---------------------------------------------------------------------------

// Maps beamId -> active WebSocket connection
const connections = new Map<string, WebSocket>()

// Maps nonce -> pending result waiter
const pendingResults = new Map<string, {
  resolve: (frame: ResultFrame) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

    // Verify agent is registered before allowing connection
    const agent = getAgent(db, beamId)
    if (!agent) {
      ws.close(1008, `Agent ${beamId} is not registered`)
      return
    }

    // Close any existing connection for this beamId
    const existingWs = connections.get(beamId)
    if (existingWs && existingWs.readyState === WebSocket.OPEN) {
      existingWs.close(1001, 'Replaced by new connection')
    }

    connections.set(beamId, ws)
    updateLastSeen(db, beamId)

    // Notify client of successful connection
    sendJson(ws, { type: 'connected', beamId })

    ws.on('message', (data: Buffer) => {
      void handleMessage(db, beamId, ws, data)
    })

    ws.on('close', () => {
      // Only remove from registry if this is still the active connection
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

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

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
  // Basic frame validation
  if (!frame || typeof frame.nonce !== 'string' || typeof frame.to !== 'string') {
    sendJson(senderWs, {
      type: 'error',
      message: 'Invalid intent frame: missing required fields (nonce, to)',
    })
    return
  }

  // Ensure the sender matches the claimed 'from' field
  if (frame.from !== senderBeamId) {
    sendJson(senderWs, {
      type: 'error',
      nonce: frame.nonce,
      message: `from field (${frame.from}) does not match connected beamId (${senderBeamId})`,
    })
    return
  }

  // Look up sender's public key so the recipient can verify the signature
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

  // Set up result waiter with 30s timeout
  const resultPromise = new Promise<ResultFrame>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResults.delete(frame.nonce)
      reject(new Error('Intent timed out waiting for result (30s)'))
    }, 30_000)

    pendingResults.set(frame.nonce, { resolve, reject, timeout })
  })

  // Deliver the intent to the recipient, including sender's public key
  sendJson(recipientWs, {
    type: 'intent',
    frame,
    senderPublicKey: senderAgent.public_key,
  })

  // Update sender's last seen on activity
  updateLastSeen(db, senderBeamId)

  // Await result and forward back to sender
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
    // Cannot identify which waiter to resolve — drop silently
    return
  }

  const pending = pendingResults.get(frame.nonce)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingResults.delete(frame.nonce)
    pending.resolve(frame)
  }
  // If no pending waiter, result is a late reply — ignore
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sendJson(ws: WebSocket, payload: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}
