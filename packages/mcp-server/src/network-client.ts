import { randomBytes } from 'node:crypto'
import { BeamIdentity, canonicalizeFrame, type BeamIdString } from 'beam-protocol-sdk'
import type { BeamMcpConfig } from './config.js'
import {
  decryptNetworkPayload,
  encryptNetworkPayload,
  type NetworkEncryptedEnvelope,
} from './network-crypto.js'

const NETWORK_TIMEOUT_MS = 10_000
const MAX_NETWORK_RESPONSE_BYTES = 2 * 1024 * 1024

export type NetworkConnectionDecision = 'accepted' | 'declined' | 'blocked'

export interface BeamNetworkGateway {
  identity(): Promise<Record<string, unknown>>
  discover(query: string): Promise<Record<string, unknown>>
  connections(statuses?: string[]): Promise<Record<string, unknown>>
  conversations(): Promise<Record<string, unknown>>
  messages(conversationId: string, limit: number, before?: string): Promise<Record<string, unknown>>
  requestConnection(recipientBeamId: BeamIdString, message: string): Promise<Record<string, unknown>>
  respondConnection(connectionId: string, decision: NetworkConnectionDecision): Promise<Record<string, unknown>>
  openDirect(counterpartBeamId: BeamIdString): Promise<Record<string, unknown>>
  createGroup(title: string, memberBeamIds: BeamIdString[]): Promise<Record<string, unknown>>
  sendMessage(conversationId: string, body: string): Promise<Record<string, unknown>>
}

type FetchLike = typeof fetch

function networkError(status: number, payload: Record<string, unknown>): Error {
  const code = typeof payload['errorCode'] === 'string' ? payload['errorCode'] : 'NETWORK_REQUEST_FAILED'
  const detail = typeof payload['error'] === 'string' ? payload['error'].slice(0, 240) : 'Beam Network request failed'
  return new Error(`${detail} (${status}: ${code})`)
}

export class BeamNetworkClient implements BeamNetworkGateway {
  private readonly identitySigner: BeamIdentity

  constructor(
    private readonly config: BeamMcpConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.identitySigner = BeamIdentity.fromData({
      beamId: config.beamId,
      publicKeyBase64: config.publicKeyBase64,
      privateKeyBase64: config.privateKeyBase64,
    })
  }

  private url(path: string, query?: URLSearchParams): URL {
    const url = new URL(path.replace(/^\//, ''), `${this.config.directoryUrl}/`)
    if (query) url.search = query.toString()
    return url
  }

  private async request(path: string, options: {
    method?: 'GET' | 'POST'
    query?: URLSearchParams
    payload?: Record<string, unknown>
  } = {}): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(this.url(path, options.query), {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        ...(options.payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.payload ? { body: JSON.stringify(options.payload) } : {}),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    })
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_NETWORK_RESPONSE_BYTES) {
      throw new Error('Beam Network response exceeded 2 MiB')
    }
    let payload: Record<string, unknown> = {}
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>
        }
      } catch {
        if (response.ok) throw new Error('Beam Network returned invalid JSON')
      }
    }
    if (!response.ok) throw networkError(response.status, payload)
    return payload
  }

  private signed(payload: Record<string, unknown>): Record<string, unknown> {
    const unsigned = {
      ...payload,
      timestamp: new Date().toISOString(),
      nonce: randomBytes(24).toString('base64url'),
    }
    return {
      ...unsigned,
      signature: this.identitySigner.sign(canonicalizeFrame(unsigned)),
    }
  }

  private decryptMessage(message: Record<string, unknown>): Record<string, unknown> {
    const envelope = message['encrypted']
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return message
    if (!this.config.dhPrivateKeyBase64) {
      return { ...message, body: '[End-to-end encrypted message]', encryptionAvailable: false }
    }
    const decrypted = decryptNetworkPayload({
      conversationId: String(message['conversationId'] ?? ''),
      senderBeamId: String(message['senderBeamId'] ?? ''),
      recipientBeamId: this.config.beamId,
      privateKeyBase64: this.config.dhPrivateKeyBase64,
      envelope: envelope as NetworkEncryptedEnvelope,
    })
    return {
      ...message,
      body: typeof decrypted['body'] === 'string' ? decrypted['body'] : '',
      attachment: decrypted['attachment'] ?? null,
      endToEndEncrypted: true,
    }
  }

  private decryptMessageList(payload: Record<string, unknown>): Record<string, unknown> {
    const messages = payload['messages']
    return Array.isArray(messages)
      ? { ...payload, messages: messages.map((message) => (
          message && typeof message === 'object' && !Array.isArray(message)
            ? this.decryptMessage(message as Record<string, unknown>)
            : message
        )) }
      : payload
  }

  private decryptConversationList(payload: Record<string, unknown>): Record<string, unknown> {
    const conversations = payload['conversations']
    if (!Array.isArray(conversations)) return payload
    return {
      ...payload,
      conversations: conversations.map((conversation) => {
        if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) return conversation
        const value = conversation as Record<string, unknown>
        const last = value['lastMessage']
        return last && typeof last === 'object' && !Array.isArray(last)
          ? { ...value, lastMessage: this.decryptMessage(last as Record<string, unknown>) }
          : value
      }),
    }
  }

  identity(): Promise<Record<string, unknown>> {
    return this.request('/network/me')
  }

  discover(query: string): Promise<Record<string, unknown>> {
    return this.request('/network/discover', { query: new URLSearchParams({ q: query }) })
  }

  connections(statuses?: string[]): Promise<Record<string, unknown>> {
    const query = statuses?.length ? new URLSearchParams({ status: statuses.join(',') }) : undefined
    return this.request('/network/connections', { query })
  }

  async conversations(): Promise<Record<string, unknown>> {
    return this.decryptConversationList(await this.request('/network/conversations'))
  }

  async messages(conversationId: string, limit: number, before?: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (before) query.set('before', before)
    return this.decryptMessageList(await this.request(`/network/conversations/${encodeURIComponent(conversationId)}/messages`, { query }))
  }

  requestConnection(recipientBeamId: BeamIdString, message: string): Promise<Record<string, unknown>> {
    return this.request('/network/connections', {
      method: 'POST',
      payload: this.signed({
        type: 'network.connection.request',
        requesterBeamId: this.config.beamId,
        recipientBeamId,
        message,
      }),
    })
  }

  respondConnection(connectionId: string, decision: NetworkConnectionDecision): Promise<Record<string, unknown>> {
    return this.request(`/network/connections/${encodeURIComponent(connectionId)}/respond`, {
      method: 'POST',
      payload: this.signed({
        type: 'network.connection.respond',
        connectionId,
        actorBeamId: this.config.beamId,
        decision,
      }),
    })
  }

  openDirect(counterpartBeamId: BeamIdString): Promise<Record<string, unknown>> {
    return this.request('/network/conversations/direct', {
      method: 'POST',
      payload: this.signed({
        type: 'network.conversation.direct',
        actorBeamId: this.config.beamId,
        counterpartBeamId,
      }),
    })
  }

  createGroup(title: string, memberBeamIds: BeamIdString[]): Promise<Record<string, unknown>> {
    return this.request('/network/groups', {
      method: 'POST',
      payload: this.signed({
        type: 'network.group.create',
        actorBeamId: this.config.beamId,
        title,
        memberBeamIds,
      }),
    })
  }

  async sendMessage(conversationId: string, body: string): Promise<Record<string, unknown>> {
    if (!this.config.dhPrivateKeyBase64 || !this.config.dhPublicKeyBase64) {
      throw new Error('This Beam connector has not configured end-to-end encryption keys')
    }
    const listing = await this.request('/network/conversations')
    const conversations = Array.isArray(listing['conversations']) ? listing['conversations'] : []
    const conversation = conversations.find((value) => (
      value && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>)['conversationId'] === conversationId
    )) as Record<string, unknown> | undefined
    if (!conversation) throw new Error('Beam conversation not found')
    const members = Array.isArray(conversation['members']) ? conversation['members'] : []
    const recipients = members.map((value) => {
      const member = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      const profile = member['profile'] && typeof member['profile'] === 'object' && !Array.isArray(member['profile'])
        ? member['profile'] as Record<string, unknown>
        : {}
      const beamId = String(member['beamId'] ?? '') as BeamIdString
      const dhPublicKey = typeof profile['dhPublicKey'] === 'string' ? profile['dhPublicKey'] : ''
      if (!beamId || !dhPublicKey) throw new Error(`${beamId || 'A conversation member'} has not enabled end-to-end encryption yet`)
      return { beamId, dhPublicKey }
    })
    const encrypted = encryptNetworkPayload({
      conversationId,
      senderBeamId: this.config.beamId,
      recipients,
      payload: { body, messageType: 'text', attachment: null },
    })
    return this.request(`/network/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      payload: this.signed({
        type: 'network.message.send',
        conversationId,
        senderBeamId: this.config.beamId,
        body: '',
        messageType: 'text',
        attachment: null,
        encrypted,
        automationDepth: 0,
      }),
    })
  }
}

export function createBeamNetworkGateway(config: BeamMcpConfig): BeamNetworkGateway {
  return new BeamNetworkClient(config)
}
