import { BeamIdentity } from './identity.js'
import { BeamDirectory } from './directory.js'
import { createIntentFrame, createResultFrame, signFrame, validateIntentFrame } from './frames.js'
import type {
  AgentRecord,
  BeamClientConfig,
  BeamIdString,
  IntentFrame,
  ResultFrame,
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

const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_FACTOR = 2

async function openWebSocket(url: string): Promise<WebSocketLike> {
  if (typeof globalThis.WebSocket !== 'undefined') {
    return new (globalThis.WebSocket as new (url: string) => WebSocketLike)(url)
  }
  const { default: WS } = await import('ws')
  return new WS(url) as unknown as WebSocketLike
}

export class BeamClient {
  private readonly _identity: BeamIdentity
  private readonly _directory: BeamDirectory
  private readonly _directoryUrl: string
  private readonly _autoReconnect: boolean
  private readonly _onDisconnect?: () => void
  private readonly _onReconnect?: () => void
  private _ws: WebSocketLike | null = null
  private _wsConnected = false
  private _isConnecting = false
  private _manualDisconnect = false
  private _reconnectAttempts = 0
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly _pendingResults = new Map<string, PendingResult>()
  private readonly _intentHandlers = new Map<string, IntentHandler>()

  constructor(config: BeamClientConfig) {
    this._identity = BeamIdentity.fromData(config.identity)
    this._directoryUrl = config.directoryUrl
    this._directory = new BeamDirectory({ baseUrl: config.directoryUrl })
    this._autoReconnect = config.autoReconnect ?? true
    this._onDisconnect = config.onDisconnect
    this._onReconnect = config.onReconnect
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
      org: parsed.org,
    })
  }

  async connect(): Promise<void> {
    if (this._ws && this._wsConnected) return
    if (this._isConnecting) {
      return new Promise<void>((resolve, reject) => {
        const startedAt = Date.now()
        const poll = () => {
          if (this._wsConnected) {
            resolve()
            return
          }
          if (!this._isConnecting) {
            reject(new Error('WebSocket connection failed'))
            return
          }
          if (Date.now() - startedAt > 30_000) {
            reject(new Error('Timed out waiting for WebSocket connection'))
            return
          }
          setTimeout(poll, 50)
        }
        poll()
      })
    }

    this._manualDisconnect = false
    this._clearReconnectTimer()
    await this._openConnection(false)
  }

  private _getWebSocketUrl(): string {
    return this._directoryUrl
      .replace(/^http:\/\//, 'ws://')
      .replace(/^https:\/\//, 'wss://')
      .replace(/\/$/, '') + `/ws?beamId=${encodeURIComponent(this._identity.beamId)}`
  }

  private async _openConnection(isReconnect: boolean): Promise<void> {
    this._isConnecting = true
    const wsUrl = this._getWebSocketUrl()

    try {
      const ws = await openWebSocket(wsUrl)
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const previousHandleMessage = this._handleMessage.bind(this)

        const finishResolve = () => {
          if (settled) return
          settled = true
          this._handleMessage = previousHandleMessage
          this._isConnecting = false
          this._wsConnected = true
          this._reconnectAttempts = 0
          resolve()
        }

        const finishReject = (error: Error) => {
          if (settled) return
          settled = true
          this._handleMessage = previousHandleMessage
          this._isConnecting = false
          this._wsConnected = false
          this._ws = null
          reject(error)
        }

        this._ws = ws

        ws.onopen = () => {
        }

        ws.onmessage = (event) => {
          this._handleMessage(event.data)
        }

        ws.onclose = () => {
          const wasConnected = this._wsConnected || settled
          this._handleSocketClose(wasConnected)
          if (!settled) {
            finishReject(new Error('WebSocket connection closed before handshake completed'))
          }
        }

        ws.onerror = (event) => {
          if (!settled) {
            finishReject(new Error(`WebSocket connection error: ${String(event)}`))
          }
        }

        this._handleMessage = (data: string) => {
          try {
            const msg = JSON.parse(data) as { type: string }
            if (msg.type === 'connected') {
              finishResolve()
              return
            }
          } catch {
          }
          previousHandleMessage(data)
        }
      })

      if (isReconnect) {
        this._onReconnect?.()
      }
    } catch (error) {
      this._isConnecting = false
      this._wsConnected = false
      this._ws = null
      if (isReconnect) {
        this._scheduleReconnect()
      }
      throw error
    }
  }

  private _handleSocketClose(wasConnected: boolean): void {
    this._wsConnected = false
    this._isConnecting = false
    this._ws = null

    for (const [nonce, pending] of this._pendingResults) {
      clearTimeout(pending.timer)
      pending.reject(new Error('WebSocket connection closed'))
      this._pendingResults.delete(nonce)
    }

    if (wasConnected) {
      this._onDisconnect?.()
    }

    if (!this._manualDisconnect && this._autoReconnect) {
      this._scheduleReconnect()
    }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer || this._isConnecting || this._manualDisconnect || !this._autoReconnect) {
      return
    }
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      return
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * (RECONNECT_FACTOR ** this._reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    )
    this._reconnectAttempts += 1

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      void this._openConnection(true).catch(() => {
        this._scheduleReconnect()
      })
    }, delay)
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
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
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private async _sendViaHttp(frame: IntentFrame): Promise<ResultFrame> {
    const baseUrl = this._directoryUrl.replace(/\/$/, '')
    const res = await fetch(`${baseUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(frame),
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
    this._manualDisconnect = true
    this._clearReconnectTimer()

    if (this._ws) {
      this._wsConnected = false
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
