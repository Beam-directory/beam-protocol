import { BeamIdentity } from './identity.js'
import { BeamDirectory } from './directory.js'
import { BeamCredentialsClient, BeamDID } from './did.js'
import { canonicalizeFrame, createIntentFrame, createResultFrame, signFrame, validateIntentFrame } from './frames.js'
import { beamIdFromApiKey } from './api-key.js'
import type {
  AgentProfile,
  AgentKeyState,
  AgentRecord,
  BeamClientConfig,
  BeamIdString,
  BrowseFilters,
  BrowseResult,
  Delegation,
  DirectoryStats,
  DomainVerification,
  IntentFrame,
  KeyRotationResult,
  KeyRevocationResult,
  Report,
  ResultFrame,
  BeamIdentityData,
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
  const { default: WS } = await import('ws')
  return new WS(url) as unknown as WebSocketLike
}

export class BeamClient {
  private _identity: BeamIdentity | null
  private readonly _beamId: BeamIdString
  private readonly _apiKey?: string
  private readonly _directory: BeamDirectory
  private readonly _did: BeamDID
  private readonly _credentials: BeamCredentialsClient
  private readonly _directoryUrl: string
  private _ws: WebSocketLike | null = null
  private _wsConnected = false
  private readonly _pendingResults = new Map<string, PendingResult>()
  private readonly _intentHandlers = new Map<string, IntentHandler>()

  constructor(config: BeamClientConfig) {
    if (!config.identity && !config.apiKey) {
      throw new Error('BeamClient requires either identity or apiKey')
    }

    this._identity = config.identity ? BeamIdentity.fromData(config.identity) : null
    this._apiKey = config.apiKey

    const resolvedBeamId = this._identity?.beamId ?? beamIdFromApiKey(config.apiKey ?? '')
    if (!resolvedBeamId) {
      throw new Error('Could not derive a Beam ID from the supplied apiKey')
    }

    this._beamId = resolvedBeamId as BeamIdString
    this._directoryUrl = config.directoryUrl
    this._directory = new BeamDirectory({ baseUrl: config.directoryUrl, apiKey: config.apiKey })
    this._did = new BeamDID({ baseUrl: config.directoryUrl, identity: this._identity ?? undefined })
    this._credentials = new BeamCredentialsClient(config.directoryUrl)
  }

  get beamId(): BeamIdString {
    return this._beamId
  }

  get directory(): BeamDirectory {
    return this._directory
  }

  get did(): BeamDID {
    return this._did
  }

  get credentials(): BeamCredentialsClient {
    return this._credentials
  }

  async register(displayName: string, capabilities: string[]): Promise<AgentRecord> {
    if (!this._identity) {
      throw new Error('register() requires an Ed25519 identity')
    }

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

  async updateProfile(fields: { description?: string; logo_url?: string; website?: string }): Promise<AgentProfile> {
    return this._directory.updateProfile(this._beamId, fields)
  }

  async verifyDomain(domain: string): Promise<DomainVerification> {
    return this._directory.verifyDomain(this._beamId, domain)
  }

  async checkDomainVerification(): Promise<DomainVerification> {
    return this._directory.checkDomainVerification(this._beamId)
  }

  async rotateKeys(newKeyPair: BeamIdentity | BeamIdentityData): Promise<KeyRotationResult> {
    if (!this._identity && !this._apiKey) {
      throw new Error('rotateKeys() requires identity or apiKey auth')
    }

    const identity = newKeyPair instanceof BeamIdentity ? newKeyPair : BeamIdentity.fromData(newKeyPair)
    const timestamp = new Date().toISOString()
    const signaturePayload = canonicalizeFrame({
      action: 'keys.rotate',
      beamId: this._beamId,
      newPublicKey: identity.publicKeyBase64,
      timestamp,
    })
    const rotationProof = this._identity ? this._identity.sign(JSON.stringify(identity.publicKeyBase64)) : undefined
    const signature = this._identity ? this._identity.sign(signaturePayload) : undefined
    const result = await this._directory.rotateKeys(this._beamId, identity.publicKeyBase64, {
      rotationProof,
      signature,
      timestamp,
    })
    this._identity = identity
    return result
  }

  async listKeys(): Promise<AgentKeyState> {
    return this._directory.listKeys(this._beamId)
  }

  async revokeKey(publicKey: string): Promise<KeyRevocationResult> {
    if (!this._identity && !this._apiKey) {
      throw new Error('revokeKey() requires identity or apiKey auth')
    }

    const timestamp = new Date().toISOString()
    const signaturePayload = canonicalizeFrame({
      action: 'keys.revoke',
      beamId: this._beamId,
      publicKey,
      timestamp,
    })
    const signature = this._identity ? this._identity.sign(signaturePayload) : undefined
    return this._directory.revokeKey(this._beamId, publicKey, { signature, timestamp })
  }

  async browse(page = 1, filters: BrowseFilters = {}): Promise<BrowseResult> {
    return this._directory.browse(page, filters)
  }

  async getStats(): Promise<DirectoryStats> {
    return this._directory.getStats()
  }

  async delegate(targetBeamId: string, scope: string, expiresIn?: number): Promise<Delegation> {
    return this._directory.delegate(this._beamId, targetBeamId as BeamIdString, scope, expiresIn)
  }

  async report(targetBeamId: string, reason: string): Promise<Report> {
    return this._directory.report(this._beamId, targetBeamId as BeamIdString, reason)
  }

  async connect(): Promise<void> {
    if (this._ws && this._wsConnected) return

    const params = new URLSearchParams({ beamId: this._beamId })
    if (this._apiKey) {
      params.set('apiKey', this._apiKey)
    }

    const wsUrl = this._directoryUrl
      .replace(/^http:\/\//, 'ws://')
      .replace(/^https:\/\//, 'wss://')
      .replace(/\/$/, '') + `/ws?${params.toString()}`

    return new Promise<void>((resolve, reject) => {
      openWebSocket(wsUrl).then((ws) => {
        this._ws = ws

        ws.onopen = () => {
        }

        ws.onmessage = (event) => {
          this._handleMessage(event.data)
        }

        ws.onclose = () => {
          this._wsConnected = false
          this._ws = null
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
      return
    }

    if (msg['type'] !== 'intent') {
      return
    }

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
      const resultFrame: ResultFrame = this._identity
        ? createResultFrame({ ...options, nonce: frame.nonce, latency }, this._identity)
        : {
            v: '1',
            success: options.success,
            nonce: frame.nonce,
            timestamp: new Date().toISOString(),
            ...(options.payload !== undefined && { payload: options.payload }),
            ...(options.error !== undefined && { error: options.error }),
            ...(options.errorCode !== undefined && { errorCode: options.errorCode }),
            ...(latency !== undefined && { latency }),
          }
      if (this._ws && this._wsConnected) {
        this._ws.send(JSON.stringify({ type: 'result', frame: resultFrame }))
      }
      return resultFrame
    }

    Promise.resolve(handler(frame, respond)).catch((error) => {
      respond({
        success: false,
        error: error instanceof Error ? error.message : 'Unhandled intent error',
        errorCode: 'INTENT_HANDLER_ERROR',
      })
    })
  }

  async send(
    to: BeamIdString,
    intent: string,
    payload?: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<ResultFrame> {
    const frame = this._identity
      ? createIntentFrame({ intent, from: this._beamId, to, payload }, this._identity)
      : {
          v: '1' as const,
          intent,
          from: this._beamId,
          to,
          payload: payload ?? {},
          nonce: BeamIdentity.generateNonce(),
          timestamp: new Date().toISOString(),
        }

    if (this._identity) {
      signFrame(frame, this._identity.export().privateKeyBase64)
    }

    if (!this._identity && !this._wsConnected) {
      await this.connect()
    }

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
        reject(err as Error)
      }
    })
  }

  private async _sendViaHttp(frame: IntentFrame): Promise<ResultFrame> {
    const baseUrl = this._directoryUrl.replace(/\/$/, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this._apiKey) {
      headers['x-api-key'] = this._apiKey
    }
    const res = await fetch(`${baseUrl}/intents/send`, {
      method: 'POST',
      headers,
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

    const payload: Record<string, unknown> = { message }
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
    this.threadId = BeamIdentity.generateNonce()
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
