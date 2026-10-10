import type { Database } from 'better-sqlite3'
import type { IntentFrame } from '../types.js'
import { loadTrustAssertion, type TrustAssertion } from './assertion.js'
import { getActiveMandate } from './mandate-store.js'
import { parseScopeGrant, type ScopeGrant } from './scopes.js'

export const UNTRUSTED_LABEL = 'UNTRUSTED_CONTENT'

export type UntrustedAttachment = {
  name: string | null
  mimeType: string | null
  byteSize: number | null
  sha256: string | null
  url?: string
  executable: false
}

export function untrustedAttachment(input: {
  name?: string | null
  mimeType?: string | null
  byteSize?: number | null
  sha256?: string | null
  url?: string
} | null): UntrustedAttachment | null {
  if (!input) return null
  return {
    name: input.name ?? null,
    mimeType: input.mimeType ?? null,
    byteSize: input.byteSize ?? null,
    sha256: input.sha256 ?? null,
    ...(input.url ? { url: input.url } : {}),
    executable: false,
  }
}

const MAX_STAPLED_TRUST_BYTES = 8_192

export type StapledTrust = { v: 1; assertion: Record<string, unknown> }

/**
 * The sender's own stapled trust assertion, passed through untouched for the
 * receiver to verify offline. The relay only checks shape, size and that it
 * names the sender; it never vouches for it.
 */
export function stapledTrustFor(value: unknown, from: string): StapledTrust | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const assertion = record['assertion']
  if (record['v'] !== 1 || !assertion || typeof assertion !== 'object' || Array.isArray(assertion)) return null
  if ((assertion as Record<string, unknown>)['beamId'] !== from) return null
  try {
    if (JSON.stringify(assertion).length > MAX_STAPLED_TRUST_BYTES) return null
  } catch {
    return null
  }
  return { v: 1, assertion: assertion as Record<string, unknown> }
}

export function stapledTrustField(stapled: StapledTrust | null | undefined): { stapledTrust?: StapledTrust } {
  return stapled ? { stapledTrust: stapled } : {}
}

export function intentTrustView(db: Database, beamId: string): { assertion: TrustAssertion | null; scopes: ScopeGrant | null } {
  const mandate = getActiveMandate(db, beamId)
  const scopes = mandate ? parseScopeGrant(JSON.parse(mandate.scopes_json) as unknown) : null
  return {
    assertion: loadTrustAssertion(db, beamId),
    scopes,
  }
}

/** Payload bytes stay beside the signed frame for current clients. This view is the only instruction-free copy. */
export function untrustedIntentEnvelope(db: Database, frame: IntentFrame): {
  untrusted: { label: typeof UNTRUSTED_LABEL; text: string | null; payload: Record<string, unknown>; attachment: UntrustedAttachment | null }
  trust: { assertion: TrustAssertion | null; scopes: ScopeGrant | null }
  metadata: { from: string; to: string; intent: string; nonce: string; timestamp: string }
  trustAssertion: TrustAssertion | null
} {
  const trust = intentTrustView(db, frame.from)
  const attachment = frame.payload['attachment'] && typeof frame.payload['attachment'] === 'object' && !Array.isArray(frame.payload['attachment'])
    ? untrustedAttachment(frame.payload['attachment'] as UntrustedAttachment)
    : frame.intent === 'file.send' || frame.intent === 'file.forward'
      ? untrustedAttachment({
          name: typeof frame.payload['name'] === 'string' ? frame.payload['name'] : null,
          mimeType: typeof frame.payload['mimeType'] === 'string' ? frame.payload['mimeType'] : null,
          byteSize: typeof frame.payload['byteSize'] === 'number' ? frame.payload['byteSize'] : null,
          sha256: typeof frame.payload['sha256'] === 'string' ? frame.payload['sha256'] : null,
        })
      : null
  return {
    untrusted: {
      label: UNTRUSTED_LABEL,
      text: typeof frame.payload['message'] === 'string' ? frame.payload['message'] : null,
      payload: frame.payload,
      attachment,
    },
    trust,
    metadata: {
      from: frame.from,
      to: frame.to,
      intent: frame.intent,
      nonce: frame.nonce,
      timestamp: frame.timestamp,
    },
    trustAssertion: trust.assertion,
  }
}
