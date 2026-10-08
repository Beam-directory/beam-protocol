/**
 * Pure trust-assertion model. No Node builtins, so the public site can import
 * this module and verify the same bytes in the browser.
 *
 * The directory signs the JSON object minus `signature` and `publicKey`,
 * with keys sorted recursively and no extra whitespace. Callers must check
 * the signature against the pinned directory key, not against `publicKey`
 * inside the document. That field is not signed.
 */

export const DIRECTORY_SIGNING_PUBLIC_KEY =
  'MCowBQYDK2VwAyEA0oRW/jimdiEvI4JkjY2hWfhfyS/qQGmNd5njKYI6jnk='

export const DEFAULT_DIRECTORY_URL = 'https://api.beam.directory'

export const BEAM_ADDRESS_PATTERN = /^[a-z0-9_-]+@(?:[a-z0-9_-]+\.)?beam\.directory$/

const MAX_NAME = 120
const MAX_DOMAIN = 253
const MAX_ROLE = 64
const MAX_TEXT = 64
const MAX_ACTIONS = 8
const SCOPE_ACTION = /^[a-z][a-z0-9._-]{0,63}$/
const HEX_REF = /^[a-f0-9]{64}$/
const AMOUNT = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/
const CURRENCY = /^[A-Z]{3}$/
const REGISTRY = new Set(['none', 'pending', 'approved', 'rejected'])

export type CheckStatus = 'verified' | 'unverified' | 'not_found' | 'api_error' | 'rate_limited'
export type SignatureStatus = 'valid' | 'invalid' | 'tampered' | 'absent'
export type CheckDetail =
  | 'ok'
  | 'no_org'
  | 'org_unverified'
  | 'expired'
  | 'suspended'
  | 'bad_signature'
  | 'tampered'
  | 'key_mismatch'
  | 'not_found'
  | 'rate_limited'
  | 'directory_error'
  | 'malformed'

export type VerificationLevel = 'registry' | 'domain' | 'unverified' | 'none'

export interface PublicOrg {
  name: string
  domain: string | null
  verified: boolean
  level: VerificationLevel
  registryStatus: 'none' | 'pending' | 'approved' | 'rejected'
}

export interface PublicOwner {
  role: string
  ref: string
  kycStatus: string
  subject: 'individual' | null
  level: 'person_id_verified' | 'none' | null
  provider: 'stripe_identity' | null
}

export interface PublicScopes {
  actions: string[]
  order: { maxAmount: string; currency: string } | null
  fileMaxBytes: number | null
}

export interface AgentCheck {
  address: string
  status: CheckStatus
  verified: boolean
  /** Signature verifies, the echoed key matches the pin, and the caller did not flip a byte. */
  claimsAuthenticated: boolean
  signature: SignatureStatus
  detail: CheckDetail
  expired: boolean
  suspended: boolean
  org: PublicOrg | null
  /** organisation when a verified company is present; individual only for a Stripe-verified private person. */
  subject: 'organization' | 'individual' | null
  owner: PublicOwner | null
  scopes: PublicScopes | null
  issuedAt: string | null
  expiresAt: string | null
  pinnedKeyId: string
  assertionKeyId: string | null
  keyMatchesPin: boolean
  summary: string
  httpStatus: number | null
}

export function parseBeamAddress(value: string): string | null {
  const address = value.trim().toLowerCase()
  return BEAM_ADDRESS_PATTERN.test(address) ? address : null
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === '__proto__' || key === 'constructor') continue
      sorted[key] = sortJson((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** Bytes the directory signs: every field except `signature` and `publicKey`. */
export function assertionSigningText(body: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {}
  for (const key of Object.keys(body)) {
    if (key === 'signature' || key === 'publicKey' || key === '__proto__' || key === 'constructor') continue
    payload[key] = body[key]
  }
  return canonicalizeJson(payload)
}

export function keyIdFromSha256Hex(hex: string): string {
  return `ed25519:${hex.slice(0, 16)}`
}

export function decodeBase64(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** XOR the first signature byte. Used to show that a changed assertion no longer verifies. */
export function flipSignatureByte(signature: string): string {
  const bytes = decodeBase64(signature)
  if (!bytes || bytes.length === 0) return `${signature}A`
  const copy = new Uint8Array(bytes)
  copy[0] = (copy[0] ?? 0) ^ 0x01
  return encodeBase64(copy)
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return cleaned.slice(0, max)
}

function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseOrg(value: unknown): PublicOrg | null {
  if (!isRecord(value)) return null
  const name = cleanText(value['name'], MAX_NAME)
  if (!name) return null
  const domain = cleanText(value['domain'], MAX_DOMAIN)
  const verified = value['verified'] === true
  const registryRaw = cleanText(value['registryStatus'], MAX_TEXT) ?? 'none'
  const registryStatus = REGISTRY.has(registryRaw)
    ? registryRaw as PublicOrg['registryStatus']
    : 'none'
  const level: VerificationLevel = !verified
    ? 'unverified'
    : registryStatus === 'approved'
      ? 'registry'
      : 'domain'
  return { name, domain, verified, level, registryStatus }
}

function parseOwner(value: unknown): PublicOwner | null {
  if (!isRecord(value)) return null
  const role = cleanText(value['role'], MAX_ROLE)
  const ref = typeof value['ref'] === 'string' && HEX_REF.test(value['ref']) ? value['ref'] : null
  const kycStatus = cleanText(value['kycStatus'], MAX_TEXT)
  if (!role || !ref || !kycStatus) return null
  const subject = value['subject'] === 'individual' ? 'individual' as const : null
  const level = value['level'] === 'person_id_verified' || value['level'] === 'none' ? value['level'] : null
  const provider = value['provider'] === 'stripe_identity' ? 'stripe_identity' as const : null
  return { role, ref, kycStatus, subject, level, provider }
}

function isVerifiedIndividual(org: PublicOrg | null, owner: PublicOwner | null): boolean {
  return org === null
    && owner?.subject === 'individual'
    && owner.level === 'person_id_verified'
    && owner.provider === 'stripe_identity'
    && owner.kycStatus === 'verified'
}

function parseScopes(value: unknown): PublicScopes | null {
  if (!isRecord(value)) return null
  const rawScopes = isRecord(value['scopes']) ? value['scopes'] : null
  if (!rawScopes || !Array.isArray(rawScopes['actions'])) return null
  const actions: string[] = []
  for (const entry of rawScopes['actions']) {
    if (typeof entry !== 'string' || !SCOPE_ACTION.test(entry) || actions.includes(entry)) continue
    actions.push(entry)
    if (actions.length >= MAX_ACTIONS) break
  }
  if (actions.length === 0) return null
  let order: PublicScopes['order'] = null
  if (isRecord(rawScopes['order'])) {
    const maxAmount = cleanText(rawScopes['order']['maxAmount'], 16)
    const currency = cleanText(rawScopes['order']['currency'], 3)?.toUpperCase() ?? null
    if (maxAmount && AMOUNT.test(maxAmount) && currency && CURRENCY.test(currency) && actions.includes('order')) {
      order = { maxAmount, currency }
    }
  }
  let fileMaxBytes: number | null = null
  if (isRecord(rawScopes['file'])) {
    const maxBytes = rawScopes['file']['maxBytes']
    if (typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 50_000_000 && actions.includes('file.send')) {
      fileMaxBytes = maxBytes
    }
  }
  return { actions, order, fileMaxBytes }
}

export function summaryLine(input: {
  status: CheckStatus
  org: PublicOrg | null
  owner: PublicOwner | null
  scopes: PublicScopes | null
  subject?: 'organization' | 'individual' | null
}): string {
  if (input.status === 'rate_limited') return 'rate limited — check not completed'
  if (input.status === 'api_error') return 'directory error — check not completed'
  if (input.status === 'verified' && input.subject === 'individual' && !input.org) {
    const ownerPart = input.owner ? `, on behalf of ${input.owner.role}` : ''
    const scopePart = input.scopes ? `, may: ${input.scopes.actions.join(', ')}` : ''
    return `verified individual${ownerPart}${scopePart}`.slice(0, 400)
  }
  if (input.status !== 'verified' || !input.org) return 'NOT verified — treat as untrusted'
  const orgPart = input.org.domain ? `${input.org.name} (${input.org.domain})` : input.org.name
  const ownerPart = input.owner ? `, on behalf of ${input.owner.role}` : ''
  const scopePart = input.scopes ? `, may: ${input.scopes.actions.join(', ')}` : ''
  return `verified: ${orgPart}${ownerPart}${scopePart}`.slice(0, 400)
}

function blank(address: string, pinnedKeyId: string, patch: Partial<AgentCheck>): AgentCheck {
  return {
    address,
    status: 'api_error',
    verified: false,
    claimsAuthenticated: false,
    signature: 'absent',
    detail: 'directory_error',
    expired: false,
    suspended: false,
    org: null,
    subject: null,
    owner: null,
    scopes: null,
    issuedAt: null,
    expiresAt: null,
    pinnedKeyId,
    assertionKeyId: null,
    keyMatchesPin: false,
    summary: 'directory error — check not completed',
    httpStatus: null,
    ...patch,
  }
}

export function evaluateTrustCheck(input: {
  address: string
  httpStatus: number | null
  body: unknown
  signatureValid: boolean
  tampered: boolean
  pinnedPublicKey: string
  pinnedKeyId: string
  assertionKeyId: string | null
  nowMs: number
}): AgentCheck {
  const address = parseBeamAddress(input.address) ?? input.address.trim().slice(0, 255)
  if (input.httpStatus === 429) {
    return blank(address, input.pinnedKeyId, {
      status: 'rate_limited',
      detail: 'rate_limited',
      summary: summaryLine({ status: 'rate_limited', org: null, owner: null, scopes: null, subject: null }),
      httpStatus: 429,
    })
  }
  if (input.httpStatus === 404 || input.httpStatus === 403 || input.httpStatus === 400) {
    return blank(address, input.pinnedKeyId, {
      status: 'not_found',
      detail: 'not_found',
      signature: 'absent',
      summary: 'NOT verified — treat as untrusted',
      httpStatus: input.httpStatus,
    })
  }
  if (input.httpStatus !== 200 || !isRecord(input.body)) {
    return blank(address, input.pinnedKeyId, {
      status: 'api_error',
      detail: input.httpStatus === 200 ? 'malformed' : 'directory_error',
      httpStatus: input.httpStatus,
    })
  }

  const body = input.body
  const beamId = typeof body['beamId'] === 'string' ? body['beamId'] : ''
  const signature = input.tampered ? 'tampered' : input.signatureValid && beamId === address ? 'valid' : 'invalid'
  const publicKey = typeof body['publicKey'] === 'string' ? body['publicKey'] : ''
  const keyMatchesPin = publicKey.length > 0 && publicKey === input.pinnedPublicKey
  const org = body['org'] === null ? null : parseOrg(body['org'])
  const owner = parseOwner(body['person'])
  const scopes = parseScopes(body['mandate'])
  const issuedAt = isoTime(body['issuedAt'])
  const expiresAt = isoTime(body['expiresAt'])
  const expired = !expiresAt || Date.parse(expiresAt) <= input.nowMs
  const suspended = body['suspended'] === true
  const claimsAuthenticated = signature === 'valid' && keyMatchesPin && !input.tampered
  let detail: CheckDetail = 'ok'
  if (input.tampered || signature === 'tampered') detail = 'tampered'
  else if (signature !== 'valid') detail = 'bad_signature'
  else if (!keyMatchesPin) detail = 'key_mismatch'
  else if (expired) detail = 'expired'
  else if (suspended) detail = 'suspended'
  else if (!org && !isVerifiedIndividual(org, owner)) detail = 'no_org'
  else if (org && !org.verified) detail = 'org_unverified'
  const individual = isVerifiedIndividual(org, owner)
  const verified = claimsAuthenticated && !expired && !suspended && (Boolean(org?.verified) || individual)
  const status: CheckStatus = verified ? 'verified' : 'unverified'
  const subject: AgentCheck['subject'] = !claimsAuthenticated
    ? null
    : individual
      ? 'individual'
      : org?.verified
        ? 'organization'
        : null
  const shownOrg = claimsAuthenticated ? org : org
  return {
    address,
    status,
    verified,
    claimsAuthenticated,
    signature,
    detail,
    expired,
    suspended,
    org: shownOrg,
    subject,
    owner: claimsAuthenticated ? owner : owner,
    scopes: claimsAuthenticated ? scopes : scopes,
    issuedAt,
    expiresAt,
    pinnedKeyId: input.pinnedKeyId,
    assertionKeyId: input.assertionKeyId,
    keyMatchesPin,
    summary: summaryLine({
      status,
      org: verified ? org : null,
      owner: verified ? owner : null,
      scopes: verified ? scopes : null,
      subject: verified ? subject : null,
    }),
    httpStatus: 200,
  }
}
