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

  /**
   * Send a natural language message to another agent.
   * The receiving agent uses its LLM to interpret and respond.
   *
   * @example
   * const reply = await client.talk(
   *   'clara@coppen.beam.directory',
   *   'Was weißt du über Chris Schnorrenberg?'
   * )
   * console.log(reply.message) // Natural language response
   * console.log(reply.structured) // Optional structured data
   */
  /**
   * Start a multi-turn conversation thread.
   * Returns a Thread object with a `say()` method for follow-ups.
   */
  thread(to: BeamIdString, options?: { language?: string; timeoutMs?: number }): BeamThread {
    return new BeamThread(this, to, options)
  }

  async talk(
    to: BeamIdString,
    message: string,
    options?: {
      context?: Record<string, unknown>
      language?: string
      timeoutMs?: number
      threadId?: string
    }
  ): Promise<{ message: string; structured?: Record<string, unknown>; threadId?: string; raw: ResultFrame }> {
    if (!message || message.length === 0) {
      throw new Error('Message must be non-empty')
    }
    if (message.length > 32768) {
      throw new Error('Message exceeds maximum length of 32768 characters')
    }

    const payload: Record<string, unknown> = {
      message,
    }
    if (options?.context) payload['context'] = options.context
    if (options?.language) payload['language'] = options.language
    if (options?.threadId) payload['threadId'] = options.threadId

    const result = await this.send(
      to,
      'conversation.message',
      payload,
      options?.timeoutMs ?? 60_000
    )

    return {
      message: (result.payload?.['message'] as string) ?? '',
      structured: result.payload?.['structured'] as Record<string, unknown> | undefined,
      threadId: (result.payload?.['threadId'] as string) ?? options?.threadId,
      raw: result,
    }
  }

  /**
   * Register a natural language handler.
   * Convenience wrapper that listens for conversation.message intents.
   *
   * @example
   * client.onTalk(async (message, from, respond) => {
   *   const answer = await myLLM.generate(message)
   *   respond(answer)
   * })
   */
  onTalk(
    handler: (
      message: string,
      from: BeamIdString,
      respond: (reply: string, structured?: Record<string, unknown>) => void,
      frame: IntentFrame
    ) => void | Promise<void>
  ): this {
    this.on('conversation.message', (frame, rawRespond) => {
      const message = (frame.payload?.['message'] as string) ?? ''
      const respond = (reply: string, structured?: Record<string, unknown>) => {
        rawRespond({
          success: true,
          payload: {
            message: reply,
            ...(structured ? { structured } : {}),
          },
        })
      }
      return handler(message, frame.from, respond, frame)
    })
    return this
  }

  disconnect(): void {
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

/**
 * A multi-turn conversation thread between two agents.
 *
 * @example
 * const chat = client.thread('clara@coppen.beam.directory')
 * const r1 = await chat.say('Was weißt du über Chris?')
 * const r2 = await chat.say('Und seine Pipeline?')  // keeps context
 */
export class BeamThread {
  readonly threadId: string
  private readonly _client: BeamClient
  private readonly _to: BeamIdString
  private readonly _language?: string
  private readonly _timeoutMs: number

  constructor(
    client: BeamClient,
    to: BeamIdString,
    options?: { language?: string; timeoutMs?: number }
  ) {
    this._client = client
    this._to = to
    this._language = options?.language
    this._timeoutMs = options?.timeoutMs ?? 60_000
    this.threadId = crypto.randomUUID()
  }

  async say(
    message: string,
    context?: Record<string, unknown>
  ): Promise<{ message: string; structured?: Record<string, unknown> }> {
    const result = await this._client.talk(this._to, message, {
      threadId: this.threadId,
      context,
      language: this._language,
      timeoutMs: this._timeoutMs,
    })
    return { message: result.message, structured: result.structured }
  }
}
