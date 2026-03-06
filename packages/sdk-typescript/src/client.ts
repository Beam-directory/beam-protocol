import { BeamIdentity } from './identity.js'
import { BeamDirectory } from './directory.js'
import { createIntentFrame, createResultFrame, signFrame, validateIntentFrame } from './frames.js'
import type {
  BeamClientConfig,
  BeamIdString,
  IntentFrame,
  ResultFrame,
  AgentRecord
} from './types.js'

interface WebSocketLike {
  readyState: number
  readonly OPEN: number
  send(data: string): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: string }) => void) | null
}

type IntentHandler = (
  frame: IntentFrame,
  respond: (options: {
    success: boolean
    payload?: Record<string, unknown>
    error?: string
    errorCode?: string
    latency?: number
  }) => ResultFrame
) => void | Promise<void>

interface PendingResult {
  resolve: (frame: ResultFrame) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

async function openWebSocket(url: string): Promise<WebSocketLike> {
  if (typeof globalThis.WebSocket !== 'undefined') {
    return new (globalThis.WebSocket as new (url: string) => WebSocketLike)(url)
  }
  // Node 18-20: use ws package
  const { default: WS } = await import('ws')
  return new WS(url) as unknown as WebSocketLike
}

export class BeamClient {
  private readonly _identity: BeamIdentity
  private readonly _directory: BeamDirectory
  private readonly _directoryUrl: string
  private _ws: WebSocketLike | null = null
  private _wsConnected = false
  private readonly _pendingResults = new Map<string, PendingResult>()
  private readonly _intentHandlers = new Map<string, IntentHandler>()

  constructor(config: BeamClientConfig) {
    this._identity = BeamIdentity.fromData(config.identity)
    this._directoryUrl = config.directoryUrl
    this._directory = new BeamDirectory({ baseUrl: config.directoryUrl })
  }

  get beamId(): BeamIdString {
    return this._identity.beamId
  }

  get directory(): BeamDirectory {
    return this._directory
  }

  async register(displayName: string, capabilities: string[]): Promise<AgentRecord> {
    const parsed = BeamIdentity.parseBeamId(this._identity.beamId)
    if (!parsed) throw new Error('Invalid beam ID on identity')

    return this._directory.register({
      beamId: this._identity.beamId,
      displayName,
      capabilities,
      publicKey: this._identity.publicKeyBase64,
      org: parsed.org
    })
  }

  async connect(): Promise<void> {
    if (this._ws && this._wsConnected) return

    // Convert http(s) scheme to ws(s) and append /ws path with beamId query param
    const wsUrl = this._directoryUrl
      .replace(/^http:\/\//, 'ws://')
      .replace(/^https:\/\//, 'wss://')
      .replace(/\/$/, '') + `/ws?beamId=${encodeURIComponent(this._identity.beamId)}`

    return new Promise<void>((resolve, reject) => {
      openWebSocket(wsUrl).then((ws) => {
        this._ws = ws

        ws.onopen = () => {
          // Wait for the server's connected message before resolving
        }

        ws.onmessage = (event) => {
          this._handleMessage(event.data)
        }

        ws.onclose = () => {
          this._wsConnected = false
          this._ws = null
          // Reject all pending results
          for (const [nonce, pending] of this._pendingResults) {
            clearTimeout(pending.timer)
            pending.reject(new Error('WebSocket connection closed'))
            this._pendingResults.delete(nonce)
          }
        }

        ws.onerror = (event) => {
          if (!this._wsConnected) {
            reject(new Error(`WebSocket connection error: ${String(event)}`))
          }
        }

        // We resolve after receiving the 'connected' message
        const originalHandleMessage = this._handleMessage.bind(this)
        this._handleMessage = (data: string) => {
          try {
            const msg = JSON.parse(data) as { type: string; beamId?: string }
            if (msg.type === 'connected') {
              this._wsConnected = true
              this._handleMessage = originalHandleMessage
              resolve()
              return
            }
          } catch {
            // ignore parse errors during connect phase
          }
          originalHandleMessage(data)
        }
      }).catch(reject)
    })
  }

  private _handleMessage(data: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }

    if (msg['type'] === 'result') {
      const frame = msg['frame'] as ResultFrame | undefined
      if (!frame) return
      const pending = this._pendingResults.get(frame.nonce)
      if (pending) {
        clearTimeout(pending.timer)
        this._pendingResults.delete(frame.nonce)
        pending.resolve(frame)
      }
    } else if (msg['type'] === 'intent') {
      const frame = msg['frame'] as IntentFrame | undefined
      const senderPublicKey = msg['senderPublicKey'] as string | undefined
      if (!frame || !senderPublicKey) return

      const validation = validateIntentFrame(frame, senderPublicKey)
      if (!validation.valid) return

      const handler = this._intentHandlers.get(frame.intent) ?? this._intentHandlers.get('*')
      if (!handler) return

      const startTime = Date.now()
      const respond = (options: {
        success: boolean
        payload?: Record<string, unknown>
        error?: string
        errorCode?: string
        latency?: number
      }): ResultFrame => {
        const latency = options.latency ?? (Date.now() - startTime)
        const resultFrame = createResultFrame(
          { ...options, nonce: frame.nonce, latency },
          this._identity
        )
        if (this._ws && this._wsConnected) {
          this._ws.send(JSON.stringify({ type: 'result', frame: resultFrame }))
        }
        return resultFrame
      }

      Promise.resolve(handler(frame, respond)).catch(() => {
        // Swallow handler errors to avoid unhandled rejections
      })
    }
  }

  async send(
    to: BeamIdString,
    intent: string,
    payload?: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<ResultFrame> {
    const frame = createIntentFrame({ intent, from: this._identity.beamId, to, payload }, this._identity)
    signFrame(frame, this._identity.export().privateKeyBase64)

    if (this._ws && this._wsConnected) {
      return this._sendViaWebSocket(frame, timeoutMs)
    }
    return this._sendViaHttp(frame)
  }

  private _sendViaWebSocket(frame: IntentFrame, timeoutMs: number): Promise<ResultFrame> {
    return new Promise<ResultFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingResults.delete(frame.nonce)
        reject(new Error(`Intent "${frame.intent}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this._pendingResults.set(frame.nonce, { resolve, reject, timer })

      try {
        this._ws!.send(JSON.stringify({ type: 'intent', frame }))
      } catch (err) {
        clearTimeout(timer)
        this._pendingResults.delete(frame.nonce)
        reject(err)
      }
    })
  }

  private async _sendViaHttp(frame: IntentFrame): Promise<ResultFrame> {
    const baseUrl = this._directoryUrl.replace(/\/$/, '')
    const res = await fetch(`${baseUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(frame)
    })
    if (!res.ok) {
      throw new Error(`HTTP intent delivery failed: ${res.status} ${res.statusText}`)
    }
    return res.json() as Promise<ResultFrame>
  }

  on(intent: string, handler: IntentHandler): this {
    this._intentHandlers.set(intent, handler)
    return this
  }

  disconnect(): void {
    if (this._ws) {
      this._wsConnected = false
      // Reject all pending results before closing
      for (const [nonce, pending] of this._pendingResults) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Client disconnected'))
        this._pendingResults.delete(nonce)
      }
      this._ws.close()
      this._ws = null
    }
  }
}
