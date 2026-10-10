import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  DEFAULT_DIRECTORY_URL,
  DIRECTORY_SIGNING_PUBLIC_KEY,
  assertionSigningText,
  decodeBase64,
  evaluateTrustCheck,
  flipSignatureByte,
  keyIdFromSha256Hex,
  parseBeamAddress,
  parseStapledAssertion,
  trustResultFromCheck,
  unverifiedTrustResult,
  type AgentCheck,
  type StapledTrustResult,
} from './trust-assertion.js'
import { intentSigningText } from './frames.js'

const MAX_BODY_BYTES = 65_536
const FETCH_TIMEOUT_MS = 8_000

export interface VerifyAgentOptions {
  directoryUrl?: string
  pinnedPublicKey?: string
  fetchImpl?: typeof fetch
  now?: Date
  /** When true, flip one signature byte before checking. Browser demos use this locally. */
  tamper?: boolean
}

function assertDirectoryUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('directoryUrl must be an https URL, or http on localhost')
  }
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('directoryUrl must be an https URL, or http on localhost')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('directoryUrl must not include credentials, a query, or a fragment')
  }
  return url.toString().replace(/\/$/, '')
}

export function spkiKeyId(publicKeyBase64: string): string | null {
  const bytes = decodeBase64(publicKeyBase64)
  if (!bytes || bytes.length === 0) return null
  return keyIdFromSha256Hex(createHash('sha256').update(bytes).digest('hex'))
}

export function verifyEd25519Spki(message: string, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    const signature = decodeBase64(signatureBase64)
    const publicKey = decodeBase64(publicKeyBase64)
    if (!signature || !publicKey) return false
    const key = createPublicKey({ key: Buffer.from(publicKey), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature))
  } catch {
    return false
  }
}

function unavailable(address: string, pinnedKeyId: string, httpStatus: number | null): AgentCheck {
  return evaluateTrustCheck({
    address,
    httpStatus,
    body: null,
    signatureValid: false,
    tampered: false,
    pinnedPublicKey: DIRECTORY_SIGNING_PUBLIC_KEY,
    pinnedKeyId,
    assertionKeyId: null,
    nowMs: Date.now(),
  })
}

/**
 * Fetch a public trust assertion and verify it against the pinned directory key.
 * No API key is sent. Directory fields are data: the returned strings are
 * length-limited and stripped of control characters.
 */
export async function verifyAgent(address: string, options: VerifyAgentOptions = {}): Promise<AgentCheck> {
  const pinnedPublicKey = options.pinnedPublicKey?.trim() || DIRECTORY_SIGNING_PUBLIC_KEY
  const pinnedKeyId = spkiKeyId(pinnedPublicKey) ?? 'ed25519:unknown'
  const parsed = parseBeamAddress(address)
  if (!parsed) {
    return evaluateTrustCheck({
      address,
      httpStatus: 400,
      body: null,
      signatureValid: false,
      tampered: false,
      pinnedPublicKey,
      pinnedKeyId,
      assertionKeyId: null,
      nowMs: options.now?.getTime() ?? Date.now(),
    })
  }

  const directoryUrl = assertDirectoryUrl(options.directoryUrl?.trim() || DEFAULT_DIRECTORY_URL)
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${directoryUrl}/agents/${encodeURIComponent(parsed)}/trust-assertion`
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    return unavailable(parsed, pinnedKeyId, null)
  }

  if (response.status >= 300 && response.status < 400) {
    return unavailable(parsed, pinnedKeyId, null)
  }
  if (response.status !== 200) {
    return evaluateTrustCheck({
      address: parsed,
      httpStatus: response.status,
      body: null,
      signatureValid: false,
      tampered: false,
      pinnedPublicKey,
      pinnedKeyId,
      assertionKeyId: null,
      nowMs: options.now?.getTime() ?? Date.now(),
    })
  }

  const text = await response.text()
  if (text.length > MAX_BODY_BYTES) return unavailable(parsed, pinnedKeyId, 200)
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return unavailable(parsed, pinnedKeyId, 200)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return unavailable(parsed, pinnedKeyId, 200)
  }
  const record = body as Record<string, unknown>
  const signingText = assertionSigningText(record)
  const signature = typeof record['signature'] === 'string' ? record['signature'] : ''
  const tampered = options.tamper === true
  const signatureToCheck = tampered ? flipSignatureByte(signature) : signature
  const signatureValid = verifyEd25519Spki(signingText, signatureToCheck, pinnedPublicKey)
  const echoedKey = typeof record['publicKey'] === 'string' ? record['publicKey'] : ''
  return evaluateTrustCheck({
    address: parsed,
    httpStatus: 200,
    body: record,
    signatureValid,
    tampered,
    pinnedPublicKey,
    pinnedKeyId,
    assertionKeyId: spkiKeyId(echoedKey),
    nowMs: options.now?.getTime() ?? Date.now(),
  })
}

export interface StapledCheckOptions {
  pinnedPublicKey?: string
  now?: Date
}

/**
 * Verify a trust assertion that travelled with a message, offline, against the
 * pinned directory key. Same rules as verifyAgent(), without a network call.
 * This checks the assertion only; use verifyStapledAssertion() to also bind it
 * to a concrete message.
 */
export function checkStapledAssertion(address: string, assertion: unknown, options: StapledCheckOptions = {}): AgentCheck {
  const pinnedPublicKey = options.pinnedPublicKey?.trim() || DIRECTORY_SIGNING_PUBLIC_KEY
  const pinnedKeyId = spkiKeyId(pinnedPublicKey) ?? 'ed25519:unknown'
  const nowMs = options.now?.getTime() ?? Date.now()
  const parsed = parseBeamAddress(address)
  if (!parsed) {
    return evaluateTrustCheck({
      address,
      httpStatus: 400,
      body: null,
      signatureValid: false,
      tampered: false,
      pinnedPublicKey,
      pinnedKeyId,
      assertionKeyId: null,
      nowMs,
    })
  }
  const record = parseStapledAssertion(assertion)
  if (!record) {
    return evaluateTrustCheck({
      address: parsed,
      httpStatus: 200,
      body: null,
      signatureValid: false,
      tampered: false,
      pinnedPublicKey,
      pinnedKeyId,
      assertionKeyId: null,
      nowMs,
    })
  }
  const signature = typeof record['signature'] === 'string' ? record['signature'] : ''
  const echoedKey = typeof record['publicKey'] === 'string' ? record['publicKey'] : ''
  return evaluateTrustCheck({
    address: parsed,
    httpStatus: 200,
    body: record,
    signatureValid: verifyEd25519Spki(assertionSigningText(record), signature, pinnedPublicKey),
    tampered: false,
    pinnedPublicKey,
    pinnedKeyId,
    assertionKeyId: spkiKeyId(echoedKey),
    nowMs,
  })
}

export interface VerifyStapledOptions extends StapledCheckOptions {
  /** The receiver's own address. A message addressed to someone else fails with `wrong_recipient`. */
  expectedRecipient?: string
  /**
   * Sender key supplied by the transport. Only used when the assertion predates
   * the signed `agentKey` field; a signed `agentKey` always wins.
   */
  senderPublicKey?: string
  /** Reject assertions issued longer ago than this, even if the directory gave them a longer life. */
  maxAssertionAgeMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Offline check of a message plus the trust assertion stapled to it:
 * 1. the assertion is signed by the pinned directory key and not expired,
 * 2. the assertion is about the message sender (`beamId === from`),
 * 3. the message was addressed to `expectedRecipient` when given,
 * 4. the message signature verifies under the agent key the directory signed into the assertion.
 * No call to Beam is made.
 */
export function verifyStapledAssertion(
  message: unknown,
  assertion: unknown,
  options: VerifyStapledOptions = {},
): StapledTrustResult {
  if (!isRecord(message) || typeof message['from'] !== 'string') {
    return unverifiedTrustResult('', 'malformed', 'stapled')
  }
  const from = message['from']
  if (assertion === undefined || assertion === null) {
    return unverifiedTrustResult(from, 'not_stapled', 'none')
  }
  const record = parseStapledAssertion(assertion)
  if (!record) return unverifiedTrustResult(from, 'malformed', 'stapled')

  const assertedBeamId = typeof record['beamId'] === 'string' ? record['beamId'] : ''
  const check = checkStapledAssertion(assertedBeamId || from, record, options)
  if (!check.claimsAuthenticated) return trustResultFromCheck(check, 'stapled')

  if (parseBeamAddress(from) !== check.address) {
    return trustResultFromCheck(check, 'stapled', 'address_mismatch')
  }
  if (options.expectedRecipient !== undefined) {
    const expected = parseBeamAddress(options.expectedRecipient)
    const to = typeof message['to'] === 'string' ? parseBeamAddress(message['to']) : null
    if (!expected || to !== expected) return trustResultFromCheck(check, 'stapled', 'wrong_recipient')
  }

  const signedAgentKey = typeof record['agentKey'] === 'string' && record['agentKey'] ? record['agentKey'] : null
  const transportKey = options.senderPublicKey?.trim() || null
  if (signedAgentKey && transportKey && signedAgentKey !== transportKey) {
    return trustResultFromCheck(check, 'stapled', 'agent_key_mismatch')
  }
  const agentKey = signedAgentKey ?? transportKey
  if (!agentKey) return trustResultFromCheck(check, 'stapled', 'no_agent_key')

  const payload = isRecord(message['payload'])
    ? message['payload']
    : isRecord(message['params']) ? message['params'] : null
  const signature = typeof message['signature'] === 'string' ? message['signature'] : ''
  const signedText = intentSigningText({
    from: message['from'],
    to: message['to'],
    intent: message['intent'],
    payload,
    timestamp: message['timestamp'],
    nonce: message['nonce'],
  })
  if (!payload || !signature || !verifyEd25519Spki(signedText, signature, agentKey)) {
    return trustResultFromCheck(check, 'stapled', 'message_signature_invalid')
  }

  if (check.expired) return trustResultFromCheck(check, 'stapled', 'expired')
  if (options.maxAssertionAgeMs !== undefined && check.issuedAt) {
    const nowMs = options.now?.getTime() ?? Date.now()
    if (nowMs - Date.parse(check.issuedAt) > options.maxAssertionAgeMs) {
      return trustResultFromCheck(check, 'stapled', 'too_old')
    }
  }
  return trustResultFromCheck(check, 'stapled')
}

/** Online fallback with the same small result shape. Makes one request to the directory. */
export async function verifyAgentTrust(address: string, options: VerifyAgentOptions = {}): Promise<StapledTrustResult> {
  return trustResultFromCheck(await verifyAgent(address, options), 'online')
}
