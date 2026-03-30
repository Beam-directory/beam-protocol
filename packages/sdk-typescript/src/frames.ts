import { randomUUID, createPrivateKey, sign } from 'node:crypto'
import type { IntentFrame, ResultFrame, BeamIdString } from './types.js'
import { BeamIdentity } from './identity.js'

export const MAX_FRAME_SIZE = 4 * 1024  // 4KB hard limit
export const REPLAY_WINDOW_MS = 5 * 60 * 1000  // 5 minutes

export function createIntentFrame(
  options: {
    intent: string
    from: BeamIdString
    to: BeamIdString
    payload?: Record<string, unknown>
  },
  identity: BeamIdentity
): IntentFrame {
  const frame: IntentFrame = {
    v: '1',
    intent: options.intent,
    from: options.from,
    to: options.to,
    payload: options.payload ?? {},
    nonce: randomUUID(),
    timestamp: new Date().toISOString()
  }
  return signFrame(frame, identity.export().privateKeyBase64)
}

export function signFrame(frame: IntentFrame, privateKeyBase64: string): IntentFrame {
  const signedPayload = JSON.stringify({
    type: 'intent',
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  })
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  frame.signature = sign(null, Buffer.from(signedPayload, 'utf8'), privateKey).toString('base64')
  return frame
}

export function createResultFrame(
  options: {
    nonce: string
    success: boolean
    payload?: Record<string, unknown>
    error?: string
    errorCode?: string
    latency?: number
  },
  identity: BeamIdentity
): ResultFrame {
  const frame: ResultFrame = {
    v: '1',
    success: options.success,
    nonce: options.nonce,
    timestamp: new Date().toISOString(),
    ...(options.payload !== undefined && { payload: options.payload }),
    ...(options.error !== undefined && { error: options.error }),
    ...(options.errorCode !== undefined && { errorCode: options.errorCode }),
    ...(options.latency !== undefined && { latency: options.latency })
  }
  frame.signature = identity.sign(canonicalizeFrame(frame as unknown as Record<string, unknown>))
  return frame
}

export function validateIntentFrame(
  frame: unknown,
  senderPublicKey: string
): { valid: boolean; error?: string } {
  if (!frame || typeof frame !== 'object') {
    return { valid: false, error: 'Frame must be an object' }
  }
  const f = frame as Record<string, unknown>

  if (f['v'] !== '1') return { valid: false, error: 'Invalid protocol version' }
  if (typeof f['intent'] !== 'string' || !f['intent']) return { valid: false, error: 'Missing or empty intent' }
  if (typeof f['from'] !== 'string' || !BeamIdentity.parseBeamId(f['from'])) {
    return { valid: false, error: 'Invalid from Beam ID' }
  }
  if (typeof f['to'] !== 'string' || !BeamIdentity.parseBeamId(f['to'])) {
    return { valid: false, error: 'Invalid to Beam ID' }
  }
  if (typeof f['nonce'] !== 'string' || !f['nonce']) return { valid: false, error: 'Missing nonce' }
  if (typeof f['timestamp'] !== 'string') return { valid: false, error: 'Missing timestamp' }

  const payload = normalizeIntentPayload(f)
  if (!payload) {
    return { valid: false, error: 'Payload must be an object' }
  }

  const size = Buffer.byteLength(JSON.stringify(frame), 'utf8')
  if (size > MAX_FRAME_SIZE) {
    return { valid: false, error: `Frame size ${size} exceeds limit of ${MAX_FRAME_SIZE} bytes` }
  }

  const frameTime = new Date(f['timestamp'] as string).getTime()
  if (isNaN(frameTime)) return { valid: false, error: 'Invalid timestamp format' }
  if (Math.abs(Date.now() - frameTime) > REPLAY_WINDOW_MS) {
    return { valid: false, error: 'Frame timestamp outside replay window (±5 minutes)' }
  }

  if (typeof f['signature'] !== 'string') return { valid: false, error: 'Missing signature' }
  const signedPayload = JSON.stringify({
    type: 'intent',
    from: f['from'],
    to: f['to'],
    intent: f['intent'],
    payload,
    timestamp: f['timestamp'],
    nonce: f['nonce'],
  })
  if (!BeamIdentity.verify(signedPayload, f['signature'] as string, senderPublicKey)) {
    return { valid: false, error: 'Signature verification failed' }
  }

  return { valid: true }
}

function normalizeIntentPayload(frame: Record<string, unknown>): Record<string, unknown> | null {
  const payload = frame['payload']
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }

  const params = frame['params']
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    frame['payload'] = params
    return params as Record<string, unknown>
  }

  return null
}

export function validateResultFrame(
  frame: unknown,
  senderPublicKey: string
): { valid: boolean; error?: string } {
  if (!frame || typeof frame !== 'object') {
    return { valid: false, error: 'Frame must be an object' }
  }
  const f = frame as Record<string, unknown>

  if (f['v'] !== '1') return { valid: false, error: 'Invalid protocol version' }
  if (typeof f['success'] !== 'boolean') return { valid: false, error: 'Missing success boolean' }
  if (typeof f['nonce'] !== 'string' || !f['nonce']) return { valid: false, error: 'Missing nonce' }
  if (typeof f['timestamp'] !== 'string') return { valid: false, error: 'Missing timestamp' }
  if (typeof f['signature'] !== 'string') return { valid: false, error: 'Missing signature' }

  const { signature, ...unsigned } = f
  if (!BeamIdentity.verify(canonicalizeFrame(unsigned), signature as string, senderPublicKey)) {
    return { valid: false, error: 'Signature verification failed' }
  }

  return { valid: true }
}

export function canonicalizeFrame(frame: Record<string, unknown>): string {
  return JSON.stringify(deepSortKeys(frame))
}

function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = deepSortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}
