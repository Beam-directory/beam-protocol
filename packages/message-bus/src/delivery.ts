/**
 * Beam Message Bus — Delivery via Beam Directory
 */

import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isRetryableDirectoryError } from './retry.js'

export interface BeamIdentityData {
  beamId: string
  publicKeyBase64: string
  privateKeyBase64: string
}

export interface DeliveryResult {
  success: boolean
  error: string
  errorCode?: string
  retryable: boolean
  status?: number
}

/** Loaded identities: beamId → privateKeyBase64 */
const identities = new Map<string, string>()

/**
 * Load Beam identities from a JSON file.
 * Format: { "agent_name": { "beamId": "...", "privateKeyBase64": "..." } }
 */
export function loadIdentities(path: string): void {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, BeamIdentityData>
    for (const [name, identity] of Object.entries(data)) {
      if (identity.beamId && identity.privateKeyBase64) {
        identities.set(identity.beamId, identity.privateKeyBase64)
      }
    }
    console.log(`[beam-bus] Loaded ${identities.size} identities`)
  } catch (err) {
    console.warn(`[beam-bus] Could not load identities from ${path}:`, err)
  }
}

/**
 * Sign a payload string with the sender's Ed25519 key.
 */
function signPayload(senderBeamId: string, payload: string): string | null {
  const privateKeyBase64 = identities.get(senderBeamId)
  if (!privateKeyBase64) return null

  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })

  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')
}

/**
 * Attempt delivery via Beam Directory HTTP relay.
 */
export async function deliverToDirectory(
  directoryUrl: string,
  msgId: string,
  nonce: string,
  sender: string,
  recipient: string,
  intent: string,
  payload: Record<string, unknown>,
): Promise<DeliveryResult> {
  const timestamp = new Date().toISOString()

  // Build frame matching Beam Protocol v1
  const frame: Record<string, unknown> = {
    v: '1',
    intent,
    from: sender,
    to: recipient,
    payload,
    nonce,
    timestamp,
  }

  // Sign — matching SDK's signFrame() format (insertion-order JSON.stringify)
  const signedPayloadStr = JSON.stringify({
    type: 'intent',
    from: sender,
    to: recipient,
    intent,
    payload,
    timestamp,
    nonce,
  })

  const signature = signPayload(sender, signedPayloadStr)
  if (signature) {
    frame.signature = signature
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)

    const resp = await fetch(`${directoryUrl}/intents/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(frame),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (resp.ok) {
      const result = await resp.json() as Record<string, unknown>
      if (result.success) {
        return { success: true, error: '', retryable: false, status: resp.status }
      }
      const errorCode = typeof result.errorCode === 'string' ? result.errorCode : undefined
      return {
        success: false,
        error: String(result.error ?? errorCode ?? 'Unknown directory error'),
        errorCode,
        retryable: isRetryableDirectoryError(errorCode, resp.status),
        status: resp.status,
      }
    }

    let errorPayload: { error?: string; errorCode?: string } | null = null
    try {
      errorPayload = await resp.clone().json() as { error?: string; errorCode?: string }
    } catch {
      errorPayload = null
    }

    const errorCode = errorPayload?.errorCode
    return {
      success: false,
      error: errorPayload?.error ?? `HTTP ${resp.status}: ${await resp.text()}`,
      errorCode,
      retryable: isRetryableDirectoryError(errorCode, resp.status),
      status: resp.status,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        success: false,
        error: 'Delivery timeout (30s)',
        errorCode: 'TIMEOUT',
        retryable: true,
      }
    }
    return {
      success: false,
      error: `Connection error: ${err}`,
      errorCode: 'DELIVERY_FAILED',
      retryable: true,
    }
  }
}
